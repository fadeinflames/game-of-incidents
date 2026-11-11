#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o postgres -g postgres -m 2775 /run/postgresql
# both clusters: 15/main (production, 5432) and 15/replica (streaming standby, 5433)
service postgresql start >/dev/null 2>&1 || true
i=0
while [ $i -lt 60 ]; do
  s=$(su postgres -c "psql -X -q -tA -p 5432 -c \"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'\"" 2>/dev/null </dev/null)
  [ "$s" = "1" ] && break
  i=$((i + 1)); sleep 0.5
done
# the seed ends on a fixed date: spread this year's orders up to now, once, so that the history has no hole before today
if [ ! -e /var/lib/storefront/.dates-spread ]; then
  su postgres -c "psql -X -q -p 5432 -d shop" >/dev/null 2>&1 <<'SQL'
SET log_statement = 'none';
UPDATE orders
   SET created_at = timestamptz '2026-01-01 00:07:00+00'
                    + (id - 6200) * ((now() - interval '90 seconds') - timestamptz '2026-01-01 00:07:00+00') / 2200
 WHERE id BETWEEN 6201 AND 8400 AND now() > timestamptz '2026-01-03 00:00:00+00';
VACUUM ANALYZE orders;
SQL
  : > /var/lib/storefront/.dates-spread
fi
service storefront start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
