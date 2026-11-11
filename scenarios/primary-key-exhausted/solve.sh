#!/bin/sh
# SECRET reference solution: widen the key and every column that stores it.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
mysql --no-defaults tracker <<'SQL'
ALTER TABLE events MODIFY id BIGINT NOT NULL AUTO_INCREMENT;
ALTER TABLE event_index MODIFY event_id BIGINT NOT NULL;
ALTER TABLE export_state MODIFY last_event_id BIGINT NOT NULL;
SQL
i=0; code=000
while [ $i -lt 30 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Content-Type: application/json' \
    -d '{"user_id": 1001, "kind": "comment"}' http://127.0.0.1:8080/events </dev/null 2>/dev/null || echo 000)
  [ "$code" = "201" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "201" ] || { echo "solve: writes still answer $code" >&2; exit 1; }
echo "solve: done"
