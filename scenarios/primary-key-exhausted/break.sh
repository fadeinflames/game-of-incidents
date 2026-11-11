#!/bin/sh
# SECRET. events.id is a signed 32-bit AUTO_INCREMENT that has been a few hundred thousand rows away from its ceiling.
# Today's import of the legacy tracker's history takes almost all of what was left; the users take the rest within seconds.
# From then on every INSERT into events fails, reads keep working.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
MYSQL="mysql --no-defaults -N -B tracker"
LOG=/var/log/tracker/import.log
LIMIT=2147483647

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 180 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 90 s" >&2; exit 1; }

post() {
  curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Content-Type: application/json' \
    -d '{"user_id": 1001, "kind": "comment"}' http://127.0.0.1:8080/events </dev/null 2>/dev/null || echo 000
}

# the stand must be healthy before it is broken
i=0; code=000
while [ $i -lt 40 ]; do
  code=$(post)
  [ "$code" = "201" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "201" ] || { echo "break: FAILED, the API did not accept an event before the break (HTTP $code)" >&2; exit 1; }

# the import runs with the users paused for a moment, so that its id range is exact: up to seven ids below the ceiling
service loadgen stop >/dev/null 2>&1
base=$($MYSQL -e "SELECT MAX(id) FROM events" </dev/null)
last=$((LIMIT - 7))
count=$((last - base))
[ "$count" -gt 1000 ] || { echo "break: FAILED, unexpected MAX(id) $base" >&2; exit 1; }
echo "$(date -u +%FT%TZ) archive-import: start, source legacy-tracker dump, $count events" >> "$LOG"
$MYSQL <<SQL || { echo "break: FAILED, the import did not run" >&2; exit 1; }
INSERT INTO events (id, user_id, kind, created_at)
SELECT $base + seq, 1000 + seq % 400, ELT(1 + seq % 6, 'comment', 'task_created', 'task_done', 'upload', 'mention', 'login'),
       NOW() - INTERVAL 400 DAY + INTERVAL seq SECOND
FROM seq_1_to_$count;
INSERT INTO event_index (event_id, user_id, bucket) SELECT id, user_id, user_id % 16 FROM events WHERE id > $base;
SQL
echo "$(date -u +%FT%TZ) archive-import: done, $count events imported, ids $((base + 1))..$last" >> "$LOG"
chown tracker:tracker "$LOG"
service loadgen start >/dev/null 2>&1

# the users take the last ids; wait for the first refused write
i=0; code=201
while [ $i -lt 60 ]; do
  code=$(post)
  [ "$code" = "500" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$code" = "500" ] || { echo "break: FAILED, writes still answer $code after the ids ran out" >&2; exit 1; }
echo "break: done (events.id at its ceiling, every write fails)"
