#!/bin/sh
# SECRET reference solution:
#   1. changefeed stops recreating its trigger on every new session (the request for an exclusive lock is the cause);
#   2. the DROP TRIGGER that is still queued in the database is removed (its client is gone, the backend is not);
#   3. the wraparound debt is paid at once: the throttled autovacuum worker is cancelled and a manual VACUUM FREEZE,
#      which is not throttled, takes its place.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
pq() { su postgres -c "psql -X -q -tA -d metadata -c \"$1\"" </dev/null; }

# 1
sed -i 's/^on_connect *=.*/on_connect = verify/' /etc/changefeed/changefeed.conf
grep -q '^on_connect = verify$' /etc/changefeed/changefeed.conf || { echo "solve: the changefeed config was not changed" >&2; exit 1; }
service changefeed restart >/dev/null 2>&1

# 2
pq "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DROP TRIGGER%'" >/dev/null
i=0; code=000
while [ $i -lt 30 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/objects/acct-1000/stor/uploads/warmup.bin" </dev/null 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] || { echo "solve: the API still answers $code" >&2; exit 1; }

# 3: the worker comes back within seconds after a cancel, so the manual vacuum must take the lock right after it;
#    a short lock_timeout and a retry cover the case when the worker was faster
i=0; frozen=no
while [ $i -lt 8 ]; do
  su postgres -c "psql -X -q -d metadata" >/dev/null 2>&1 <<'SQL' || true
SET lock_timeout = '3s';
SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker' AND query LIKE '%public.objects%';
VACUUM (FREEZE) public.objects;
SQL
  age=$(pq "SELECT age(relfrozenxid) FROM pg_class WHERE oid = 'public.objects'::regclass")
  [ "${age:-999999999}" -lt 100000000 ] && { frozen=yes; break; }
  i=$((i + 1)); sleep 1
done
[ "$frozen" = "yes" ] || { echo "solve: objects was not frozen, age ${age:-unknown}" >&2; exit 1; }
echo "solve: done (changefeed on_connect=verify, objects frozen, age $age)"
