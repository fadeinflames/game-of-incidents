#!/bin/sh
# SECRET. The install_tokens table is being moved from db-old to db-new: tablemover keeps a copy on db-new up to date
# by replaying the change log of db-old, one ordered stream, about ten changes a second.
# Tonight two things meet. The tokens team switches the cleanup of expired tokens back on: 200 000 dead rows, deleted
# at 40 rows a second, every delete is one more change in the log. The copy falls behind and keeps falling.
# Then the runbook of the database team runs its next step, the read cutover: it checks that the job is "running",
# does not look at the lag, and points the reads of tokend at db-new. Writes still go to db-old.
# A token issued now exists on db-old only, so its validation answers 404 until the applier gets to it.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
OLD="mysql --no-defaults -N -B -S /run/mysqld/db-old.sock tokens"
NEW="mysql --no-defaults -N -B -S /run/mysqld/db-new.sock tokens"
ROUTING=/etc/tokend/routing.conf
CLEANUP=/etc/tokend/cleanup.conf
RUNBOOK=/var/log/dbmove/runbook.log
API=http://127.0.0.1:8080

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

issue() {
  curl -q -s --max-time 5 -H 'Content-Type: application/json' -d '{"integration": 7}' "$API/v1/tokens" </dev/null 2>/dev/null \
    | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p'
}
validate() { curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/v1/tokens/$1" </dev/null 2>/dev/null || echo 000; }
applied() { $NEW -e "SELECT applied_seq FROM _tablemover_job WHERE job = 'tokens-move' AND state = 'running' AND heartbeat_at > NOW() - INTERVAL 10 SECOND" </dev/null 2>/dev/null; }
# "backlog lag": changes that wait for the applier, and the age in seconds of the oldest of them
behind() {
  p=$(applied)
  case "$p" in ''|*[!0-9]*) echo "-1 -1"; return ;; esac
  $OLD -e "SELECT COUNT(*), COALESCE(TIMESTAMPDIFF(SECOND, MIN(ts), NOW()), 0) FROM _tablemover_changes WHERE seq > $p" </dev/null 2>/dev/null | tr '\t' ' '
}
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# the stand must be healthy before it is broken: a fresh token validates at once, the migration keeps up
i=0; ok=0; code=000; state="-1 -1"
while [ $i -lt 15 ]; do
  t=$(issue); code=000
  [ -n "$t" ] && code=$(validate "$t")
  state=$(behind)
  if [ "$code" = 200 ]; then
    case "$state" in "0 "*|"1 "*|"2 "*|"3 "*) ok=1; break ;; esac
  fi
  i=$((i + 1)); sleep 1
done
[ $ok = 1 ] || { echo "break: FAILED, the stand is not healthy (fresh token: HTTP $code, backlog and lag: $state)" >&2; exit 1; }
grep -q '^reads = db-old$' "$ROUTING" || { echo "break: FAILED, unexpected routing file" >&2; exit 1; }

# 1. the tokens team switches the cleanup back on; the first run starts now, cron starts the next ones every minute
sed -i "s/^enabled = no\$/# $(date -u '+%Y-%m-%d %H:%M') UTC: enabled again, APP-2291 (more than 200 000 dead rows in install_tokens)\nenabled = yes/" "$CLEANUP"
grep -q '^enabled = yes$' "$CLEANUP" || { echo "break: FAILED, could not enable the cleanup" >&2; exit 1; }
start-stop-daemon --start --quiet --background --make-pidfile --pidfile /run/token-cleanup.first.pid --chuid tokend \
  --startas /bin/sh -- -c 'exec /opt/tokend/token-cleanup >> /var/log/token-cleanup/cleanup.log 2>&1' \
  || { echo "break: FAILED, could not start the first cleanup run" >&2; exit 1; }
rm -f /run/token-cleanup.first.pid

# 2. the copy on db-new falls behind
NEED_CHANGES=400; NEED_LAG=20
i=0; n=0; lag=0
while [ $i -lt 50 ]; do
  state=$(behind); n=${state% *}; lag=${state#* }
  [ "$n" -ge $NEED_CHANGES ] 2>/dev/null && [ "$lag" -ge $NEED_LAG ] 2>/dev/null && break
  i=$((i + 1)); sleep 1
done
{ [ "$n" -ge $NEED_CHANGES ] && [ "$lag" -ge $NEED_LAG ]; } 2>/dev/null \
  || { echo "break: FAILED, the migration did not fall behind in 50 s (backlog and lag: $state)" >&2; exit 1; }

# 3. the runbook of the database team: the read cutover, without a look at the lag
at=$(date -u -d '+45 minutes' +%H:%M)
{
  echo "$(stamp) dbmove: step 2/5 done: the maintenance window is open"
  echo "$(stamp) dbmove: step 3/5 started: read cutover of install_tokens"
  echo "$(stamp) dbmove:   precheck: tablemover job tokens-move: state running, last error none ... ok"
  echo "$(stamp) dbmove:   precheck: db-new accepts connections, install_tokens exists ... ok"
  echo "$(stamp) dbmove:   $ROUTING: [install_tokens] reads: db-old -> db-new"
} >> "$RUNBOOK"
sed -i 's/^reads = db-old$/reads = db-new/' "$ROUTING"
service tokend reload >/dev/null 2>&1
i=0; ok=0
while [ $i -lt 20 ]; do
  curl -q -s --max-time 3 "$API/admin/routing" </dev/null 2>/dev/null | grep -q '"reads": "db-new"' && { ok=1; break; }
  i=$((i + 1)); sleep 0.5
done
[ $ok = 1 ] || { echo "break: FAILED, tokend did not take the new routing" >&2; exit 1; }
{
  echo "$(stamp) dbmove:   service tokend reload ... ok"
  echo "$(stamp) dbmove: step 3/5 done: reads of install_tokens are served by db-new"
  echo "$(stamp) dbmove: step 4/5 waiting: write cutover at $at UTC, needs a confirmation from the operator"
} >> "$RUNBOOK"

# 4. the breakage must be visible: a token issued now is not found
i=0; code=000
while [ $i -lt 15 ]; do
  t=$(issue); code=000
  [ -n "$t" ] && code=$(validate "$t")
  [ "$code" = 404 ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = 404 ] || { echo "break: FAILED, a fresh token still validates (HTTP $code)" >&2; exit 1; }
echo "break: done (reads on db-new, writes on db-old, the copy is $lag s and $n changes behind and falling further)"
