#!/bin/sh
# SECRET grader: postgres up, writes work, the old orders are intact, free space >= 20 %, orders API accepts orders.
# Result, not method. The password is deliberately not read from /etc/app/app.env: the player can edit that file.
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export PGPASSWORD=shop-s3cret

ok_pg=false;   msg_pg="PostgreSQL не отвечает (pg_isready)"
ok_ins=false;  msg_ins="INSERT в shop.orders не проходит"
ok_data=false; msg_data="не удалось подтвердить, что прежние заказы в базе на месте"
ok_free=false; msg_free="на /var/lib/postgresql свободно меньше 20 %"
ok_api=false;  msg_api="POST /order не отвечает 201"

if /usr/bin/pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then ok_pg=true; msg_pg="PostgreSQL отвечает"; fi
if $ok_pg && /usr/bin/psql -X -q -h 127.0.0.1 -U shop -d shop -tAc "INSERT INTO orders (amount, note) VALUES (1.00, 'grader') RETURNING id" 2>/dev/null | /usr/bin/grep -qE '^[0-9]+$'; then
  ok_ins=true; msg_ins="запись в базу работает"
fi
# 2000 orders come with the image, 50 more are written by break.sh right before the disk fills up
if $ok_pg; then
  counts=$(/usr/bin/psql -X -q -h 127.0.0.1 -U shop -d shop -tAc "SELECT count(*) FILTER (WHERE note LIKE 'seed %'), count(*) FILTER (WHERE note LIKE 'night %') FROM orders" 2>/dev/null)
  seed=${counts%%|*}; night=${counts#*|}
  case "$seed$night" in
    ''|*[!0-9]*) ;;
    *) if [ "$seed" -ge 2000 ] && [ "$night" -ge 50 ]; then ok_data=true; msg_data="прежние заказы на месте"; fi ;;
  esac
fi
pct=$(/usr/bin/df --output=pcent /var/lib/postgresql 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$pct" ] && [ "$pct" -le 80 ]; then ok_free=true; msg_free="на разделе занято ${pct} %"; else msg_free="на разделе занято ${pct:-?} %"; fi
i=0; code=000
while [ $i -lt 5 ]; do
  code=$(/usr/bin/curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST http://127.0.0.1:8080/order 2>/dev/null || echo 000)
  [ "$code" = "201" ] && break
  i=$((i + 1)); sleep 1
done
if [ "$code" = "201" ]; then ok_api=true; msg_api="POST /order → 201"; else msg_api="POST /order → $code"; fi

passed=false
if $ok_pg && $ok_ins && $ok_data && $ok_free && $ok_api; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"postgres-up","ok":%s,"message":"%s"},' "$ok_pg" "$msg_pg"
printf '{"id":"insert-works","ok":%s,"message":"%s"},' "$ok_ins" "$msg_ins"
printf '{"id":"data-intact","ok":%s,"message":"%s"},' "$ok_data" "$msg_data"
printf '{"id":"free-space","ok":%s,"message":"%s"},' "$ok_free" "$msg_free"
printf '{"id":"api-201","ok":%s,"message":"%s"}' "$ok_api" "$msg_api"
printf ']}\n'
