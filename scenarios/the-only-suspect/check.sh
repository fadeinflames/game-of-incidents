#!/bin/sh
# SECRET grader. Result, not method:
#   1. the data path works: writes and reads through the API reach the table;
#   2. nothing waits for a lock on the table;
#   3. the change feed delivers (the capture trigger is there, the events reach the feed);
#   4. the failure does not come back: with a long reader on the table (the same obstacle to an exclusive lock as a long
#      vacuum) and the feed service forced to reconnect, the data path and the feed keep working;
#   5. the protection against transaction id wraparound is on, and the table is either below the threshold or being
#      vacuumed right now.
# Nothing is read from the config files under /etc: the player can edit them. Connections go through the local socket
# as postgres, psql runs with -X, curl with -q.
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
FEED=/var/lib/changefeed/feed.jsonl
TABLE="'public.objects'::regclass"
token="g$$x$(date +%s)"

pq() { su postgres -c "PGOPTIONS='-c statement_timeout=8000 -c lock_timeout=3000' psql -X -q -tA -d metadata -c \"$1\"" </dev/null 2>/dev/null; }
put() { curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -X PUT --data-binary "$1" "$API/objects/grader/$1" </dev/null 2>/dev/null || echo 000; }
get() { curl -q -s --max-time 5 "$API/objects/grader/$1" </dev/null 2>/dev/null; }
in_feed() { cat "$FEED.1" "$FEED" 2>/dev/null | grep -qF "/grader/$1\""; }

ok_api=false;  msg_api="API не обслуживает запросы к объектам"
ok_wait=false; msg_wait="в базе есть запросы, которые ждут блокировку таблицы objects"
ok_feed=false; msg_feed="лента изменений не доставляет события"
ok_again=false; msg_again="не проверялось: сначала должны заработать путь данных и лента изменений"
ok_xid=false;  msg_xid="защита от переполнения счётчика транзакций не в порядке"

# 1. four writes and four reads through the API; a stand that is plainly down is not hammered for a minute
good=0; total=0; i=0
while [ $i -lt 4 ]; do
  [ "$(put "$token-$i")" = "200" ] && good=$((good + 1))
  case "$(get "$token-$i")" in *"/grader/$token-$i"*etag*) good=$((good + 1)) ;; esac
  total=$((total + 2)); i=$((i + 1))
  [ $i -eq 1 ] && [ $good -eq 0 ] && break
  sleep 0.3
done
rows=0
[ $good -gt 0 ] && rows=$(pq "SELECT count(*) FROM public.objects WHERE path LIKE '/grader/$token-%'")
if [ $good -eq 8 ] && [ "${rows:-0}" = "4" ]; then ok_api=true; msg_api="запись и чтение объектов через API работают"
elif [ $good -eq 8 ]; then msg_api="API отвечает 200, но записанных объектов в таблице objects нет"
else msg_api="API не обслуживает запросы к объектам: успешно $good из $total"
fi

# 2. a lock request on the table that has been waiting for more than a second
waiting=$(pq "SELECT count(*) FROM pg_locks WHERE relation = $TABLE AND NOT granted AND waitstart < now() - interval '1 second'")
case "$waiting" in
  0) ok_wait=true; msg_wait="блокировку таблицы objects никто не ждёт" ;;
  ''|*[!0-9]*) msg_wait="не удалось опросить базу metadata" ;;
  *) msg_wait="блокировку таблицы objects ждут запросы, сейчас их $waiting" ;;
esac

# 3. the trigger exists and is enabled, the events of step 1 are in the feed
trig=$(pq "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $TABLE AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND p.proname = 'changefeed_capture'")
if [ "${trig:-0}" -ge 1 ] 2>/dev/null && $ok_api; then
  i=0
  while [ $i -lt 16 ]; do
    in_feed "$token-3" && break
    i=$((i + 1)); sleep 0.5
  done
  if in_feed "$token-3"; then ok_feed=true; msg_feed="лента изменений доставляет события"; else msg_feed="лента изменений не доставила событие о записанном объекте за 8 с"; fi
elif $ok_api; then msg_feed="на таблице objects нет работающего триггера ленты изменений"
fi

# 4. reproduction: a transaction that keeps reading the table (ACCESS SHARE, compatible with everything the data path
#    does), then the feed service loses its sessions and has to reconnect
if $ok_api && $ok_wait && $ok_feed; then
  su postgres -c "PGAPPNAME=grader-probe psql -X -q -d metadata" >/dev/null 2>&1 <<'SQL' &
BEGIN;
SET LOCAL lock_timeout = '3s';
LOCK TABLE public.objects IN ACCESS SHARE MODE;
SELECT pg_sleep(16);
COMMIT;
SQL
  probe=$!
  i=0; held=0
  while [ $i -lt 8 ]; do
    held=$(pq "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.relation = $TABLE AND l.granted AND l.mode = 'AccessShareLock' AND a.application_name = 'grader-probe'")
    [ "${held:-0}" = "1" ] && break
    i=$((i + 1)); sleep 0.5
  done
  if [ "${held:-0}" != "1" ]; then
    msg_again="грейдер не смог открыть транзакцию чтения на таблице objects"
  else
    t0=$(pq "SELECT clock_timestamp()")
    pq "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'changefeed'" >/dev/null
    i=0; back=0
    while [ $i -lt 14 ]; do
      back=$(pq "SELECT count(*) FROM pg_stat_activity WHERE usename = 'changefeed' AND backend_start > '$t0'::timestamptz")
      [ "${back:-0}" -ge 1 ] 2>/dev/null && break
      i=$((i + 1)); sleep 0.5
    done
    if [ "${back:-0}" -ge 1 ] 2>/dev/null; then
      sleep 1.5
      good2=0; excl=0; i=0
      while [ $i -lt 3 ]; do
        [ "$(put "$token-r$i")" = "200" ] && good2=$((good2 + 1))
        case "$(get "$token-r$i")" in *"/grader/$token-r$i"*etag*) good2=$((good2 + 1)) ;; esac
        n=$(pq "SELECT count(*) FROM pg_locks WHERE relation = $TABLE AND NOT granted AND mode = 'AccessExclusiveLock'")
        [ "${n:-0}" != "0" ] && excl=1
        i=$((i + 1))
        [ $good2 -lt $((i * 2)) ] && break
        sleep 0.4
      done
      delivered=false
      if [ $good2 -eq 6 ]; then
        i=0
        while [ $i -lt 10 ]; do
          in_feed "$token-r2" && { delivered=true; break; }
          i=$((i + 1)); sleep 0.5
        done
      fi
      if [ $good2 -eq 6 ] && [ $excl -eq 0 ] && $delivered; then
        ok_again=true; msg_again="долгая транзакция на таблице и переподключение сервисов не останавливают путь данных и ленту"
      elif [ $good2 -lt 6 ] || [ $excl -ne 0 ]; then
        msg_again="сбой воспроизводится: грейдер открыл долгую транзакцию чтения на таблице objects и оборвал постоянные сессии сервисов в базе; после переподключения запросы к таблице снова встали в очередь"
      else
        msg_again="сбой воспроизводится частично: при долгой транзакции чтения на таблице objects и после обрыва постоянных сессий сервисов лента изменений перестала доставлять события"
      fi
    else
      msg_again="после обрыва сессий сервис changefeed не подключился к базе за 7 с"
    fi
  fi
  pq "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'grader-probe'" >/dev/null
  wait "$probe" 2>/dev/null
fi

# the grader's own objects are removed (not on a stand where the table is locked: the statement would only join the queue)
if [ "${rows:-0}" != "0" ] && $ok_wait; then pq "DELETE FROM public.objects WHERE path LIKE '/grader/$token-%'" >/dev/null; fi

# 5. wraparound protection: autovacuum is on, and the table is below the threshold or a vacuum is working on it
av=$(pq "SHOW autovacuum")
off=$(pq "SELECT count(*) FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = $TABLE AND o ~* '^autovacuum_enabled=(false|off|no|0|f|n)'")
over=$(pq "SELECT (age(c.relfrozenxid) >= LEAST(current_setting('autovacuum_freeze_max_age')::bigint, COALESCE((SELECT split_part(o, '=', 2)::bigint FROM unnest(c.reloptions) o WHERE o LIKE 'autovacuum_freeze_max_age=%'), 2000000000)))::int FROM pg_class c WHERE c.oid = $TABLE")
if [ "$av" != "on" ] || [ "$off" != "0" ]; then
  msg_xid="автовакуум выключен (в настройках сервера или для таблицы objects): защита от переполнения счётчика транзакций должна остаться включённой"
elif [ "$over" = "0" ]; then
  ok_xid=true; msg_xid="защита от переполнения счётчика транзакций включена"
elif [ "$over" = "1" ]; then
  i=0; running=0
  while [ $i -lt 30 ]; do
    running=$(pq "SELECT count(*) FROM pg_stat_progress_vacuum WHERE relid = $TABLE")
    [ "${running:-0}" -ge 1 ] 2>/dev/null && break
    i=$((i + 1)); sleep 1
  done
  if [ "${running:-0}" -ge 1 ] 2>/dev/null; then ok_xid=true; msg_xid="защита от переполнения счётчика транзакций включена"
  else msg_xid="таблица objects старше порога заморозки, а вакуум по ней не идёт"
  fi
else
  msg_xid="не удалось опросить базу metadata"
fi

passed=false
if $ok_api && $ok_wait && $ok_feed && $ok_again && $ok_xid; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"data-path","ok":%s,"message":"%s"},' "$ok_api" "$msg_api"
printf '{"id":"no-lock-queue","ok":%s,"message":"%s"},' "$ok_wait" "$msg_wait"
printf '{"id":"change-feed","ok":%s,"message":"%s"},' "$ok_feed" "$msg_feed"
printf '{"id":"does-not-return","ok":%s,"message":"%s"},' "$ok_again" "$msg_again"
printf '{"id":"xid-protection","ok":%s,"message":"%s"}' "$ok_xid" "$msg_xid"
printf ']}\n'
