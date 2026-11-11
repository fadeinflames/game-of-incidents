#!/bin/sh
# SECRET. Time passes: the cluster serves the last transactions that separate the objects table from
# autovacuum_freeze_max_age. The launcher starts an autovacuum "to prevent wraparound" on it; that kind is not cancelled
# by a conflicting lock request and, throttled as it is here, runs for more than an hour. The next time changefeed opens a
# session it issues DROP TRIGGER, which asks for an exclusive lock and waits behind the vacuum; every later reader and
# writer of the table waits behind that request.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
pq() { su postgres -c "psql -X -q -tA -d metadata -c \"$1\"" </dev/null 2>/dev/null; }

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

# the stand must be healthy before it is broken: the API writes and reads, changefeed has been through its trigger step
i=0; put=000; get=000; feed=0
while [ $i -lt 40 ]; do
  put=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -X PUT --data-binary warmup "$API/objects/acct-1000/stor/uploads/warmup.bin" </dev/null 2>/dev/null || echo 000)
  get=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/objects/acct-1000/stor/uploads/warmup.bin" </dev/null 2>/dev/null || echo 000)
  feed=$(grep -c 'is in place' /var/log/changefeed/changefeed.log 2>/dev/null || true)
  [ "$put" = "200" ] && [ "$get" = "200" ] && [ "${feed:-0}" -ge 1 ] && break
  i=$((i + 1)); sleep 1
done
{ [ "$put" = "200" ] && [ "$get" = "200" ] && [ "${feed:-0}" -ge 1 ]; } || { echo "break: FAILED, the stand did not come up healthy (PUT $put, GET $get, changefeed trigger steps: ${feed:-0})" >&2; exit 1; }

# burn transaction ids until the table is past the threshold (about 80 000 are missing after the build)
limit=$(pq "SELECT current_setting('autovacuum_freeze_max_age')::bigint + 30000")
i=0; age=0
while [ $i -lt 10 ]; do
  age=$(pq "SELECT age(relfrozenxid) FROM pg_class WHERE oid = 'public.objects'::regclass")
  [ "${age:-0}" -gt "${limit:-200030000}" ] && break
  su postgres -c "psql -X -q -d postgres" >/dev/null 2>&1 <<'SQL'
SET synchronous_commit = off;
DO $$ BEGIN FOR i IN 1..40000 LOOP PERFORM txid_current(); COMMIT; END LOOP; END $$;
SQL
  i=$((i + 1))
done
[ "${age:-0}" -gt "${limit:-200030000}" ] || { echo "break: FAILED, the age of objects is ${age:-unknown}, expected more than ${limit:-unknown}" >&2; exit 1; }

# the anti-wraparound worker on the table
i=0; worker=""
while [ $i -lt 70 ]; do
  worker=$(pq "SELECT pid FROM pg_stat_activity WHERE backend_type = 'autovacuum worker' AND query LIKE '%public.objects%to prevent wraparound%' LIMIT 1")
  [ -n "$worker" ] && break
  i=$((i + 1)); sleep 1
done
[ -n "$worker" ] || { echo "break: FAILED, no autovacuum to prevent wraparound on objects after 70 s" >&2; exit 1; }

# changefeed opens a new session every 30 s: wait for its DROP TRIGGER to queue behind the vacuum
i=0; ddl=""
while [ $i -lt 50 ]; do
  ddl=$(pq "SELECT pid FROM pg_stat_activity WHERE usename = 'changefeed' AND wait_event_type = 'Lock' AND query LIKE 'DROP TRIGGER%' LIMIT 1")
  [ -n "$ddl" ] && break
  i=$((i + 1)); sleep 1
done
[ -n "$ddl" ] || { echo "break: FAILED, changefeed did not queue its DROP TRIGGER behind the vacuum in 50 s" >&2; exit 1; }

# the data path must be visibly down: queries queue up and the API stops answering 200
i=0; code=200; waiting=0
while [ $i -lt 20 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 6 "$API/objects/acct-1000/stor/uploads/warmup.bin" </dev/null 2>/dev/null || echo 000)
  waiting=$(pq "SELECT count(*) FROM pg_locks WHERE relation = 'public.objects'::regclass AND NOT granted")
  [ "$code" != "200" ] && [ "${waiting:-0}" -ge 5 ] && break
  i=$((i + 1)); sleep 1
done
{ [ "$code" != "200" ] && [ "${waiting:-0}" -ge 5 ]; } || { echo "break: FAILED, the data path still works (GET $code, ${waiting:-0} lock waiters)" >&2; exit 1; }
echo "break: done (objects age $age, autovacuum worker $worker, DROP TRIGGER backend $ddl, $waiting lock waiters, GET answers $code)"
