#!/bin/sh
# SECRET. The platform's scheduler starts a background cleanup job, token-sweeper, against the authz primary.
# The job handles a batch of installs in one transaction and paces itself inside that transaction, so each of its
# workers keeps the counter rows of its integrations locked for about a minute. Token writes of gate-api update the
# same rows: they wait, the API repeats them on new sessions, and the waiting sessions take every connection slot of
# the primary. The safeguard of the job watches the replay lag of the standby, and that stays at zero.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGAPPNAME
SOCK=/var/run/postgresql
API=http://127.0.0.1:8080
TOKEN=gat_87acbf50432f77c754eaa4e66977d900   # the seeded service token of install 10 (project 71)

fail() { echo "break: FAILED, $*" >&2; exit 1; }
q() { runuser -u postgres -- psql -X -q -tA -h "$SOCK" -p "$1" -d authz -c "$2" </dev/null 2>/dev/null; }
api_read() { curl -q -s -o /dev/null -w '%{http_code}\n' --max-time 6 -H "Authorization: Bearer $TOKEN" "$API/v1/projects/71" </dev/null 2>/dev/null | head -n 1; }
api_token() { curl -q -s -o /dev/null -w '%{http_code}\n' --max-time 8 -X POST -H 'Content-Type: application/json' --data '{"label":"warmup"}' "$API/v1/installs/$1/access_tokens" </dev/null 2>/dev/null | head -n 1; }

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 90 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || fail "the container init did not finish in 45 s"

# the stand must be healthy first: the standby streams, the API checks permissions and issues tokens, the clients work
i=0; ready=0
while [ $i -lt 30 ]; do
  rep=$(q 5432 "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")
  rd=$(api_read)
  tk=$(api_token 7)
  ci=$(q 5433 "SELECT count(*) FROM access_tokens WHERE id > 89600 AND label LIKE 'ci-job-%'")
  if [ "$rep" = "1" ] && [ "$rd" = "200" ] && [ "$tk" = "201" ] && [ "${ci:-0}" -ge 3 ] 2>/dev/null; then ready=1; break; fi
  i=$((i + 1)); sleep 1
done
[ $ready -eq 1 ] || fail "the stand is not healthy (standbys: ${rep:-?}, read: ${rd:-?}, token: ${tk:-?}, client tokens on the standby: ${ci:-?})"

# the scheduler starts the cleanup job
service token-sweeper start >/dev/null 2>&1 || fail "token-sweeper did not start"

# the breakage is visible when token writes queue behind the job, the primary has no free slots for the API
# and authenticated requests fail
waiting=0; total=0; bad=0
deadline=$(($(date +%s) + 70))
while [ "$(date +%s)" -lt "$deadline" ]; do
  waiting=$(q 5432 "SELECT count(*) FROM pg_stat_activity WHERE usename = 'gate_api' AND wait_event_type = 'Lock'")
  total=$(q 5432 "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()")
  if [ "${waiting:-0}" -ge 25 ] 2>/dev/null && [ "${total:-0}" -ge 35 ] 2>/dev/null; then
    if [ "$(api_read)" != "200" ]; then bad=$((bad + 1)); else bad=0; fi
    [ $bad -ge 3 ] && break
  fi
  sleep 1
done
[ $bad -ge 3 ] || fail "the pile-up did not form in time (lock waiters: ${waiting:-?}, client sessions: ${total:-?})"
lag=$(q 5432 "SELECT COALESCE(EXTRACT(EPOCH FROM replay_lag), 0)::numeric(10,3) FROM pg_stat_replication WHERE application_name = '15/replica'")
echo "break: done (token-sweeper is running, $waiting API sessions wait for row locks, $total client sessions on the primary, replay lag ${lag:-?} s)"
