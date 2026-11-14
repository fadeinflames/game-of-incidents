#!/bin/sh
# SECRET. The database team's approved change CHG-2291 is handed to the migrator: drop two indexes that newer composite
# indexes made redundant, shard by shard, with a soak of six minutes after each shard.
# board-api still pins its two list queries to exactly these indexes (FORCE INDEX from /etc/board-api/settings.conf), so
# on every shard the change has reached the task list and the feed fail with error 1176 and the user gets a 500.
# The runner does the first shard at once; the second follows in six minutes, the third in twelve.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
CHANGES=/var/lib/migrator/changes

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 180 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 90 s" >&2; exit 1; }

code() {
  curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$API$1" </dev/null 2>/dev/null || echo 000
}

# the stand must be healthy before it is broken: both list pages answer on every shard
i=0; ok=no
while [ $i -lt 40 ]; do
  if [ "$(code /users/1042/tasks)$(code /users/1042/feed)$(code /users/2042/tasks)$(code /users/3042/feed)" = "200200200200" ]; then ok=yes; break; fi
  i=$((i + 1)); sleep 1
done
[ "$ok" = yes ] || { echo "break: FAILED, the API did not serve the pages of all three shards before the break" >&2; exit 1; }
service migrator status >/dev/null 2>&1 || { echo "break: FAILED, the migrator service is not running" >&2; exit 1; }

# hand the change over: the plan appears in one step, the runner picks it up on its next tick
approved=$(date -u -d '2 days ago' +%F)
cat > "$CHANGES/.CHG-2291.tmp" <<JSON
{
  "id": "CHG-2291",
  "title": "Drop two indexes superseded by CHG-2274",
  "requested_by": "db-team",
  "approved": "change board, $approved",
  "reason": "idx_tasks_owner and idx_comments_author repeat the first column of the composite indexes added in CHG-2274; they take disk space and slow down every write. Code search over board-api: no query names them.",
  "shards": ["board_s1", "board_s2", "board_s3"],
  "soak_sec": 360,
  "statements": [
    "ALTER TABLE tasks DROP INDEX IF EXISTS idx_tasks_owner",
    "ALTER TABLE comments DROP INDEX IF EXISTS idx_comments_author"
  ]
}
JSON
chown migrator:migrator "$CHANGES/.CHG-2291.tmp"
mv "$CHANGES/.CHG-2291.tmp" "$CHANGES/CHG-2291.json"

# the breakage must be visible: both list pages of a shard 1 user fail, the profile and the other shards still answer
i=0; got=
while [ $i -lt 60 ]; do
  got="$(code /users/1042/tasks) $(code /users/1042/feed) $(code /users/1042) $(code /users/2042/tasks) $(code /users/3042/feed)"
  [ "$got" = "500 500 200 200 200" ] && { echo "break: done (CHG-2291 has reached board_s1, the next shard follows after the soak)"; exit 0; }
  i=$((i + 1)); sleep 0.5
done
echo "break: FAILED, expected '500 500 200 200 200', got '$got'" >&2
exit 1
