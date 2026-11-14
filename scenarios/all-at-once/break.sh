#!/bin/sh
# SECRET. Five hours ago the platform team finished the queue namespace migration: the two fan-out queues of the
# advisory pipeline got the team prefix. The concurrency limits in /etc/jobrunner/limits.yml are keyed by queue name,
# and the two entries still carry the old names, so the new queues have no limit at all. Routine advisories (a dozen
# repositories) never showed it. Now an advisory for a popular package is published: 48 000 jobs, all 96 workers
# take them, every job holds a database connection, max_connections is 40. The users' actions fail.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
MYSQL="mysql --no-defaults -N -B secalerts"
LIMITS=/etc/jobrunner/limits.yml
JLOG=/var/log/jobrunner/jobrunner.log
SPOOL=/var/spool/advisory-feed
BULK_JOBS=30000
FULL=38

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 180 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 90 s" >&2; exit 1; }

api() { curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:8080/alerts/$1" </dev/null 2>/dev/null || echo 000; }
limit_of() { redis-cli -h 127.0.0.1 -p 6379 get jobrunner:state </dev/null 2>/dev/null | jq -r --arg q "$1" '.queues[$q].limit' 2>/dev/null; }
conns() { $MYSQL -e "SELECT COUNT(*) FROM information_schema.processlist WHERE user = 'jobrunner'" </dev/null 2>/dev/null || echo 0; }
iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }

# the stand must be healthy before it is broken: the API reads from the database, the fan-out queues are limited
i=0; code=000; lim=
while [ $i -lt 40 ]; do
  code=$(api 1); lim=$(limit_of secalerts.advisory_fanout)
  [ "$code" = "200" ] && [ "$lim" = "6" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] && [ "$lim" = "6" ] || { echo "break: FAILED, the stand is not healthy (GET /alerts/1 -> $code, fan-out limit '$lim')" >&2; exit 1; }

# 1. the limits file as the migration left it: wave 1 (eight days ago) renamed its three entries, wave 2 renamed nothing
cat > "$LIMITS" <<'EOF'
# jobrunner on alerts-01: per-queue concurrency limits.
# The number is how many jobs of that queue may run at the same time.
# Format and how to apply a change: /usr/share/doc/jobrunner/README
limits:
  secalerts.mailers: 4
  secalerts.webhooks: 6
  secalerts.exports: 2
  # advisory pipeline: one job per affected repository, and every job holds a database
  # connection for as long as it runs. 6 + 6 is what was agreed with the DBA team.
  advisory_fanout: 6
  advisory_fanout_bulk: 6
EOF
chown root:root "$LIMITS"; chmod 0644 "$LIMITS"
touch -d '8 days ago 13:02' "$LIMITS" 2>/dev/null || true

# 2. the pool as it has been running since the migration
service jobrunner restart >/dev/null 2>&1
i=0; lim=6
while [ $i -lt 40 ]; do
  lim=$(limit_of secalerts.advisory_fanout)
  [ "$lim" = "null" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$lim" = "null" ] || { echo "break: FAILED, jobrunner did not come back without the fan-out limits (limit '$lim')" >&2; exit 1; }
pid=$(cat /run/jobrunner.pid 2>/dev/null)

# 3. the last day in the log of the pool, written from what the database knows about that day: the run before the
#    migration (old queue names, limits in effect, the large advisory of yesterday worked off at 12 jobs at a time)
#    and the run since the migration (new names, no limit on the fan-out queues, only routine advisories so far)
$MYSQL -e "SELECT advisory_id, repo_id, UNIX_TIMESTAMP(created_at) FROM alerts ORDER BY created_at, id" </dev/null > /tmp/.jr-history.tsv \
  || { echo "break: FAILED, cannot read the history of alerts" >&2; exit 1; }
python3 -I - "$pid" "$JLOG" <<'PY' || { echo "break: FAILED, the log history was not written" >&2; exit 1; }
import collections
import os
import random
import sys
import time

live_pid, path = int(sys.argv[1]), sys.argv[2]
old_pid = max(300, live_pid - 187)
now = int(time.time())
wave2 = now - (5 * 3600 + 12 * 60 + 44)
prev = now - (24 * 3600 + 40 * 60 + 17)
rnd = random.Random(4127)


def ts(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def block(t, pid, fanout):
    head = "%s jobrunner[%d]: " % (ts(t), pid)
    return [head + "starting: jobrunner 2.9.4, pool concurrency=96, app /opt/secalerts/jobs.py, redis 127.0.0.1:6379\n",
            head + "limits: 5 entries loaded from /etc/jobrunner/limits.yml\n",
            head + "listening on 5 queues: secalerts.mailers (limit 4), secalerts.webhooks (limit 6), secalerts.exports (limit 2), " + fanout + "\n"]


def run(rows, start, stop, pid, peak):
    """Lines of one run of the pool: a 'done' line per alert and a stats line for every ten seconds with work in them."""
    mine = [x for x in rows if start + 2 <= x[2] < stop]
    done = [(t, 0, n, "%s jobrunner[%d]: [worker-%03d] done AdvisoryRepoMatch advisory=%d repo=%d in %.1fs\n"
             % (ts(t), pid, rnd.randint(1, 96), a, r, rnd.uniform(3.0, 6.0))) for n, (a, r, t) in enumerate(mine)]
    per_bucket = collections.Counter((t - start) // 10 for a, r, t in mine)
    stats = [(start + (b + 1) * 10, 1, 0, "%s jobrunner[%d]: stats 10s: done=%d (AdvisoryRepoMatch=%d AlertMail=%d) failed=0 requeued=0 peak_busy=%d/96\n"
              % (ts(start + (b + 1) * 10), pid, 2 * n, n, n, peak(n))) for b, n in per_bucket.items() if start + (b + 1) * 10 < stop]
    return [x[3] for x in sorted(done + stats)]


# (comprehensions, not loop statements: the platform's linter reads every loop of this file as a shell wait loop)
rows = [(int(a), int(r), int(float(t))) for a, r, t in (line.split("\t") for line in open("/tmp/.jr-history.tsv"))]

before = block(prev, old_pid, "advisory_fanout (limit 6), advisory_fanout_bulk (limit 6)")
before += run(rows, prev, wave2 - 40, old_pid, lambda n: min(16, 12 + n // 6))
before.append("%s jobrunner[%d]: stopping: 0 jobs in flight, waiting up to 12 s for them\n" % (ts(wave2 - 38), old_pid))
before.append("%s jobrunner[%d]: stopped\n" % (ts(wave2 - 38), old_pid))
since = block(wave2, live_pid, "secalerts.advisory_fanout (no limit), secalerts.advisory_fanout_bulk (no limit)")
since += run(rows, wave2, now - 20, live_pid, lambda n: min(20, n + 2))

with open(path + ".1", "w") as f:
    f.writelines(before)
os.chmod(path + ".1", 0o644)
os.utime(path + ".1", (wave2 - 38, wave2 - 38))
# the pool is running and appends to its log: the history replaces the file in one write
data = "".join(since).encode()
fd = os.open(path, os.O_WRONLY | os.O_TRUNC)
written = os.write(fd, data)
os.close(fd)
sys.exit(0 if written == len(data) else 1)
PY
rm -f /tmp/.jr-history.tsv
chown jobrunner:jobrunner "$JLOG.1" 2>/dev/null || true

# 4. the change journal of the host
{
  echo "# alerts-01: changes made on this host. Newest at the bottom. One line per change: time (UTC), team, change id, what was done."
  echo "$(iso '13 days ago 09:30') dba CHG-3988 MariaDB 10.11 minor upgrade on alerts-01, restart in the maintenance window. No parameter changes."
  echo "$(iso '8 days ago 13:05') platform-queues CHG-4051 queue namespace migration, wave 1 of 2: mailers -> secalerts.mailers, webhooks -> secalerts.webhooks, exports -> secalerts.exports. Producers and jobrunner switched together, old queues were empty and are deleted. Checked: mail and webhook jobs run on the new queues."
  echo "$(iso '6 days ago 10:41') secalerts CHG-4102 alerts-api 4.17.2: pagination of GET /repos/<id>/alerts fixed. Service restarted."
  echo "$(iso '24 hours ago 42 minutes ago') sre CHG-4119 jobrunner 2.9.3 -> 2.9.4 (format of the stats line in the log). Service restarted."
  echo "$(iso '5 hours ago 15 minutes ago') platform-queues CHG-4127 queue namespace migration, wave 2 of 2 (advisory pipeline): advisory_fanout -> secalerts.advisory_fanout, advisory_fanout_bulk -> secalerts.advisory_fanout_bulk. Release 4.18.0 of the secalerts services: advisory-feed and the jobs switched together, the old queues were empty and are deleted, jobrunner restarted. Checked: a test advisory went through the new queues, its alerts were created. Migration closed."
} > /var/log/ops/changes.log
chmod 0644 /var/log/ops/changes.log

# 5. the advisory database delivers the advisory for a package that 48 000 repositories depend on
cat > "$SPOOL/incoming/.lantern-log.tmp" <<'EOF'
{"package": "lantern-log", "ecosystem": "npm", "severity": "critical",
 "summary": "Remote code execution in lantern-log through crafted format strings: upgrade to 5.2.1",
 "repos": {"from": 10001, "count": 48000}}
EOF
chown secalerts:secalerts "$SPOOL/incoming/.lantern-log.tmp"
mv "$SPOOL/incoming/.lantern-log.tmp" "$SPOOL/incoming/lantern-log.json"

# the feed records the advisory and queues the jobs; the pool takes them at full width
i=0; q=0
while [ $i -lt 60 ]; do
  q=$(redis-cli -h 127.0.0.1 -p 6379 llen secalerts.advisory_fanout_bulk </dev/null 2>/dev/null)
  [ "${q:-0}" -ge "$BULK_JOBS" ] 2>/dev/null && break
  i=$((i + 1)); sleep 1
done
[ "${q:-0}" -ge "$BULK_JOBS" ] 2>/dev/null || { echo "break: FAILED, the advisory was not fanned out (bulk queue holds '${q:-}' jobs)" >&2; exit 1; }
i=0; c=0
while [ $i -lt 40 ]; do
  c=$(conns)
  [ "${c:-0}" -ge "$FULL" ] 2>/dev/null && break
  i=$((i + 1)); sleep 1
done
[ "${c:-0}" -ge "$FULL" ] 2>/dev/null || { echo "break: FAILED, the workers did not fill the database connections ($c of 40)" >&2; exit 1; }

# 6. the previous on-call engineer restarts the pool: nothing changes
sleep 4
service jobrunner restart >/dev/null 2>&1

# the breakage must be visible: the connections are taken again and user requests are refused
i=0; c=0; bad=0
while [ $i -lt 60 ]; do
  c=$(conns); bad=0
  for n in 2 3 4 5 6 7; do [ "$(api $n)" = "503" ] && bad=$((bad + 1)); done
  [ "${c:-0}" -ge "$FULL" ] 2>/dev/null && [ $bad -ge 4 ] && break
  i=$((i + 1)); sleep 1
done
[ "${c:-0}" -ge "$FULL" ] 2>/dev/null && [ $bad -ge 4 ] || { echo "break: FAILED, the breakage is not visible ($c worker connections, $bad of 6 requests refused)" >&2; exit 1; }
echo "break: done (48 000 fan-out jobs, $c worker connections of 40, $bad of 6 user requests refused)"
