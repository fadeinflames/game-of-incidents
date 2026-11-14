#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
# token-sweeper is not started here: it is a background job that the platform's scheduler starts when its turn comes.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o postgres -g postgres -m 2775 /run/postgresql
# both clusters: 15/main (primary, 5432) and 15/replica (streaming standby, 5433)
service postgresql start >/dev/null 2>&1 || true
i=0
while [ $i -lt 80 ]; do
  s=$(su postgres -c "psql -X -q -tA -p 5432 -c \"SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'\"" 2>/dev/null </dev/null)
  [ "$s" = "1" ] && break
  i=$((i + 1)); sleep 0.5
done
service gate-api start >/dev/null 2>&1 || true
service trafficgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
