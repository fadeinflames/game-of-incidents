#!/bin/sh
# SECRET reference solution: the cleanup job is paused the way its owner meant it to be paused (the pause file from
# its config). Its workers commit what they have done and close their transactions, the queued token writes get their
# row locks, the abandoned sessions go away and the primary has free connection slots again. Nothing is restarted,
# no database parameter is touched, the job keeps its progress and can be resumed by its owner.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGAPPNAME
SOCK=/var/run/postgresql
API=http://127.0.0.1:8080
TOKEN=gat_87acbf50432f77c754eaa4e66977d900  # secret-scan: allow (a stand fixture: the sample token printed in the brief)
q() { runuser -u postgres -- psql -X -q -tA -h "$SOCK" -p 5432 -d authz -c "$1" </dev/null 2>/dev/null; }

install -o sweeper -g sweeper -m 0644 /dev/null /var/lib/token-sweeper/pause

# the workers notice the file after the install they are working on: at most a couple of seconds
i=0; open=1; waiting=1
while [ $i -lt 40 ]; do
  open=$(q "SELECT count(*) FROM pg_stat_activity WHERE usename = 'sweeper' AND xact_start IS NOT NULL" || echo 1)
  waiting=$(q "SELECT count(*) FROM pg_stat_activity WHERE usename = 'gate_api' AND wait_event_type = 'Lock'" || echo 1)
  [ "$open" = "0" ] && [ "$waiting" = "0" ] && break
  i=$((i + 1)); sleep 1
done
[ "$open" = "0" ] && [ "$waiting" = "0" ] || { echo "solve: the job still has $open open transactions, $waiting token writes wait" >&2; exit 1; }

# the service is back: permission checks and token writes
i=0; good=0
while [ $i -lt 30 ] && [ $good -lt 3 ]; do
  rd=$(curl -q -s -o /dev/null -w '%{http_code}\n' --max-time 5 -H "Authorization: Bearer $TOKEN" "$API/v1/projects/71" </dev/null 2>/dev/null | head -n 1)
  tk=$(curl -q -s -o /dev/null -w '%{http_code}\n' --max-time 8 -X POST -H 'Content-Type: application/json' --data '{"label":"after-pause"}' "$API/v1/installs/$((i + 1))/access_tokens" </dev/null 2>/dev/null | head -n 1)
  if [ "$rd" = "200" ] && [ "$tk" = "201" ]; then good=$((good + 1)); else good=0; fi
  i=$((i + 1)); sleep 1
done
[ $good -ge 3 ] || { echo "solve: the API did not recover (read $rd, token $tk)" >&2; exit 1; }
echo "solve: done (token-sweeper is paused, $(q "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'") client sessions on the primary)"
