#!/bin/sh
# SECRET grader. Result, not method:
#   writes work, every column that holds an event id is 64-bit, the export job runs, and the old data is still there.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
MYSQL="mysql --no-defaults -N -B tracker"
OLD_LIMIT=2147483647
# 200 000 events come with the image, at least 83 000 more are imported by break.sh
MIN_OLD=283000

ok_write=false; msg_write="POST /events не отвечает 201"
ok_types=false; msg_types="схема базы не гарантирует, что проблема не повторится"
ok_export=false; msg_export="задача выгрузки tracker-export завершается с ошибкой"
ok_data=false;  msg_data="не удалось подтвердить, что прежние события на месте"

# 1. five writes in a row
good=0; i=0; code=000
while [ $i -lt 5 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Content-Type: application/json' \
    -d '{"user_id": 4242, "kind": "comment"}' http://127.0.0.1:8080/events </dev/null 2>/dev/null || echo 000)
  [ "$code" = "201" ] && good=$((good + 1))
  i=$((i + 1))
done
if [ $good -eq 5 ]; then ok_write=true; msg_write="запись событий работает (5 из 5)"; else msg_write="POST /events: 201 только на $good из 5 запросов (последний ответ $code)"; fi

# 2. the three places an event id is stored in
wide=$($MYSQL -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'tracker' AND data_type = 'bigint' AND ((table_name = 'events' AND column_name = 'id') OR (table_name = 'event_index' AND column_name = 'event_id') OR (table_name = 'export_state' AND column_name = 'last_event_id'))" </dev/null 2>/dev/null)
case "$wide" in
  3) ok_types=true; msg_types="идентификатор события 64-битный везде, где он хранится" ;;
  ''|*[!0-9]*) msg_types="не удалось прочитать схему базы tracker" ;;
  0) ;;
  *) msg_types="исправление сделано не везде, где оно нужно ($wide из 3 мест)" ;;
esac

# 3. the export job, run the way cron runs it
if su -s /bin/sh tracker -c "/usr/bin/python3 /opt/tracker/export.py" </dev/null >/dev/null 2>&1; then
  caught=$($MYSQL -e "SELECT last_event_id >= (SELECT MAX(id) FROM events) - 100 FROM export_state WHERE job = 'analytics'" </dev/null 2>/dev/null)
  if [ "$caught" = "1" ]; then ok_export=true; msg_export="задача выгрузки отрабатывает и догнала свежие события"; else msg_export="задача выгрузки отработала, но её позиция отстаёт от свежих событий"; fi
fi

# 4. nothing was thrown away to make room
old=$($MYSQL -e "SELECT COUNT(*) FROM events WHERE id <= $OLD_LIMIT" </dev/null 2>/dev/null)
idx=$($MYSQL -e "SELECT COUNT(*) FROM event_index WHERE event_id <= $OLD_LIMIT" </dev/null 2>/dev/null)
case "$old$idx" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$old" -ge $MIN_OLD ] && [ "$idx" -ge $MIN_OLD ]; then ok_data=true; msg_data="прежние события и их индекс на месте"
    else msg_data="часть прежних событий или их индекса пропала (событий $old, строк индекса $idx)"
    fi ;;
esac

passed=false
if $ok_write && $ok_types && $ok_export && $ok_data; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"writes-work","ok":%s,"message":"%s"},' "$ok_write" "$msg_write"
printf '{"id":"ids-64bit","ok":%s,"message":"%s"},' "$ok_types" "$msg_types"
printf '{"id":"export-works","ok":%s,"message":"%s"},' "$ok_export" "$msg_export"
printf '{"id":"data-intact","ok":%s,"message":"%s"}' "$ok_data" "$msg_data"
printf ']}\n'
