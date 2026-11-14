#!/bin/sh
# SECRET reference solution: hold the change, take both index pins out of the API settings, apply and verify them,
# then let the change finish on the remaining shards and look at the pages of every shard again.
set -eu
PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
CONF=/etc/board-api/settings.conf

code() {
  curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$API$1" </dev/null 2>/dev/null || echo 000
}
old_left() {
  mysql --no-defaults -N -B -e "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema IN ('board_s1', 'board_s2', 'board_s3') AND ((table_name = 'tasks' AND index_name = 'idx_tasks_owner') OR (table_name = 'comments' AND index_name = 'idx_comments_author'))" </dev/null
}

# 1. no further shard until the API is ready for it
migratectl pause >/dev/null

# 2. both settings off, applied with a reload, checked against what the running service reports
sed -i -e 's/^[[:space:]]*tasks_list_index[[:space:]]*=.*/tasks_list_index =/' \
       -e 's/^[[:space:]]*feed_index[[:space:]]*=.*/feed_index =/' "$CONF"
service board-api reload >/dev/null 2>&1
i=0; eff=
while [ $i -lt 20 ]; do
  eff=$(curl -q -s --max-time 5 "$API/admin/settings" </dev/null 2>/dev/null | jq -c '[.tasks_list_index, .feed_index]' 2>/dev/null || true)
  [ "$eff" = "[null,null]" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$eff" = "[null,null]" ] || { echo "solve: the running API still reports $eff" >&2; exit 1; }
[ "$(code /users/1042/tasks) $(code /users/1042/feed)" = "200 200" ] || { echo "solve: the pages of a shard 1 user still fail" >&2; exit 1; }

# 3. the change goes on: skip the soak before each remaining shard
migratectl resume >/dev/null
i=0; left=$(old_left)
while [ "$left" != "0" ] && [ $i -lt 40 ]; do
  migratectl next >/dev/null 2>&1 || true
  i=$((i + 1)); sleep 2
  left=$(old_left)
done
[ "$left" = "0" ] || { echo "solve: the change did not finish, $left old index entries are left" >&2; exit 1; }

# 4. every shard again, both list pages
for u in 1042 2042 3042; do
  got="$(code /users/$u) $(code /users/$u/tasks) $(code /users/$u/feed)"
  [ "$got" = "200 200 200" ] || { echo "solve: user $u gets $got after the change" >&2; exit 1; }
done
echo "solve: done"
