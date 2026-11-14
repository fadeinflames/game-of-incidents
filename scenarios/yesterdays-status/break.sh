#!/bin/sh
# SECRET. A week before the monthly reset a safeguard was added to the settings of budget-worker: do not apply a budget
# state that a gateway measured before the last reset. The value was written as "yes", which is not TOML: settingsd could
# not load the file and has served the built-in defaults (safeguard off) ever since, with one line in its log.
# After the reset the worker is behind: thousands of budget updates wait in the queue, many of them late usage records
# of the closed period. For the customers who had exhausted last month's budget those records carry "exhausted", and
# the worker writes that state back into the cache that the reset had cleared. access-api serves it: they stay refused.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
SETTINGS=http://127.0.0.1:8500/v1/settings/budget-worker
QUEUE=queue:budget-updates
AFFECTED="1004 1011 1017 1023 1029 1036 1042 1048 1055"

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 180 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 90 s" >&2; exit 1; }

allowed() { curl -q -s --max-time 4 "$API/v1/access/$1" </dev/null 2>/dev/null | grep -c '"allowed": true'; }
flag() { curl -q -s --max-time 4 "$SETTINGS" </dev/null 2>/dev/null | grep -o '"access.discard_state_before_reset": [a-z]*' | awk '{ print $2 }'; }

# the stand must be healthy before it is broken: the safeguard is on, the worker has it, the API lets a customer in
i=0; ok=0; f=; a=0; w=0
while [ $i -lt 40 ]; do
  f=$(flag); a=$(allowed 1001)
  w=$(grep -c 'access.discard_state_before_reset=true' /var/log/budget-worker/worker.log 2>/dev/null || true)
  if [ "$f" = "true" ] && [ "${a:-0}" = "1" ] && [ "${w:-0}" -ge 1 ]; then ok=1; break; fi
  i=$((i + 1)); sleep 1
done
[ $ok = 1 ] || { echo "break: FAILED, the stand is not healthy (flag=$f api=$a worker=$w)" >&2; exit 1; }

service usage-meter stop >/dev/null 2>&1
service budget-worker stop >/dev/null 2>&1
service settingsd stop >/dev/null 2>&1

# the value that is not TOML, dated a week ago
cat > /etc/settingsd/namespaces/budget-worker.toml <<'EOF'
# Namespace "budget-worker", served by settingsd.
# After a change: service settingsd reload. The worker asks settingsd every 15 seconds.

[queue]
# how many events from queue:budget-updates the worker applies per poll
batch_size = 2
poll_interval_ms = 1000

[access]
# lifetime of a cached access status, seconds
status_ttl_sec = 21600
# BUD-412, ahead of the monthly reset
discard_state_before_reset = yes
EOF
chmod 0644 /etc/settingsd/namespaces/budget-worker.toml

python3 -I - <<'PY' || { echo "break: FAILED, the backlog was not prepared" >&2; exit 1; }
import datetime
import json
import os
import random
import time
import tomllib

import psycopg2
import redis

AFFECTED = [1004, 1011, 1017, 1023, 1029, 1036, 1042, 1048, 1055]
EXHAUSTED_NOW = [1008, 1019, 1033, 1040, 1051]
STAND_INS = [1001, 1003, 1005, 1007, 1009, 1012, 1013, 1015, 1016]
QUEUE = "queue:budget-updates"
TOML = "/etc/settingsd/namespaces/budget-worker.toml"
UTC = datetime.timezone.utc
iso = lambda ts: ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

rnd = random.Random(41207)
now = datetime.datetime.now(UTC).replace(microsecond=0)
db = psycopg2.connect("host=127.0.0.1 port=5432 dbname=budgets user=budget password=bw-rw-58c1 connect_timeout=5")
cur = db.cursor()
cur.execute("SELECT period, started_at FROM billing_periods ORDER BY started_at DESC LIMIT 2")
(current, reset), (closed, _) = cur.fetchall()
cur.execute("SELECT customer_id, limit_cents FROM budgets")
limits = dict(cur.fetchall())
cur.execute("SELECT customer_id, spent_cents FROM usage_history WHERE period = %s", (closed,))
history = dict(cur.fetchall())
ids = sorted(limits)
store = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)

# the affected customers have been refused since the reset: whatever they did in the first seconds of this stand is
# booked to other customers, in the database and in the events that are still queued
swap = dict(zip(AFFECTED, STAND_INS))


def rebook(src, dst):
    cur.execute("UPDATE usage_ledger SET customer_id = %s WHERE customer_id = %s AND at >= %s", (dst, src, reset))
    cur.execute("UPDATE usage_current SET spent_cents = spent_cents + (SELECT spent_cents FROM usage_current WHERE customer_id = %s) "
                "WHERE customer_id = %s", (src, dst))
    cur.execute("UPDATE usage_current SET spent_cents = 0, updated_at = %s WHERE customer_id = %s", (reset, src))


def requeued(raw):
    ev = json.loads(raw)
    if ev.get("customer") in swap and "budget_state" not in ev:
        ev["customer"] = swap[ev["customer"]]
    return json.dumps(ev)


[rebook(src, dst) for src, dst in swap.items()]
db.commit()
pending = [requeued(raw) for raw in store.lrange(QUEUE + ":processing", 0, -1) + store.lrange(QUEUE, 0, -1)]
store.delete(QUEUE, QUEUE + ":processing")

# the backlog: 6400 events queued over the last 95 minutes
TOTAL = 6400
t0, t1 = now - datetime.timedelta(minutes=95), now - datetime.timedelta(seconds=40)
normal = [c for c in ids if c not in AFFECTED and c not in EXHAUSTED_NOW]
others = [c for c in ids if c not in AFFECTED]
changes = {4100: (1019, 8000), 3700: (1023, 18000), 4700: (1014, 8000), 5000: (1040, 8000), 5300: (1026, 1500),
           5600: (1048, 9000), 5900: (1014, 6000), 6100: (1002, 15000), 6250: (1045, 20000)}
head = [("late-state", c) for c in AFFECTED] + [("usage", None)] * 11 + [("late", None)] * 4
rnd.shuffle(head)
last = int(store.incrby("meter:seq", TOTAL))
first = last - TOTAL + 1


def event(pos):
    queued = t0 + (t1 - t0) * pos / (TOTAL - 1)
    ev = {"seq": first + pos, "queued_at": iso(queued)}
    if pos in changes:
        customer, new_limit = changes[pos]
        ev.update(type="limit_change", customer=customer, new_limit_cents=new_limit, at=iso(queued))
        return json.dumps(ev)
    if pos < len(head):
        kind, customer = head[pos]
    else:
        roll = rnd.random()
        kind, customer = ("late-state", None) if roll < 0.18 else ("late", None) if roll < 0.30 else ("usage", None)
    ev.update(type="usage", node="gw-%d" % rnd.randint(1, 4))
    if kind == "usage":
        ev.update(customer=rnd.choice(normal), at=iso(queued - datetime.timedelta(seconds=rnd.randint(1, 4))),
                  amount_cents=rnd.randint(30, 120) if rnd.random() < 0.03 else rnd.randint(1, 6))
        return json.dumps(ev)
    ev.update(at=iso(reset - datetime.timedelta(seconds=rnd.randint(90, 3 * 3600))), amount_cents=rnd.randint(1, 6))
    if kind == "late-state":
        customer = customer or rnd.choice(AFFECTED)
        ev.update(customer=customer, budget_state="exhausted", spent_cents=history[customer], limit_cents=limits[customer])
    else:
        ev["customer"] = rnd.choice(others)
    return json.dumps(ev)


backlog = [event(pos) for pos in range(TOTAL)]
[store.rpush(QUEUE, *backlog[n:n + 400]) for n in range(0, TOTAL, 400)]
if pending:
    store.rpush(QUEUE, *pending)

# the settings file was changed a week ago, and settingsd was told to reload it then
changed = time.time() - 7 * 86400 - 5 * 3600
os.utime(TOML, (changed, changed))
try:
    with open(TOML, "rb") as fh:
        tomllib.load(fh)
    raise SystemExit("the settings file still parses")
except tomllib.TOMLDecodeError as exc:
    error = str(exc)
stamp = lambda ago: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - ago))
api_ns = "namespace access-api: 1 values from /etc/settingsd/namespaces/access-api.toml"
lines = [
    "%s INFO settingsd 1.6.0 starting, schema /opt/settingsd/schema.json" % stamp(41 * 86400 + 7 * 3600 + 131),
    "%s INFO %s" % (stamp(41 * 86400 + 7 * 3600 + 131), api_ns),
    "%s INFO namespace budget-worker: 3 values from %s" % (stamp(41 * 86400 + 7 * 3600 + 131), TOML),
    "%s INFO listening on 127.0.0.1:8500" % stamp(41 * 86400 + 7 * 3600 + 131),
    "%s INFO reload requested (SIGHUP)" % stamp(7 * 86400 + 5 * 3600 - 38),
    "%s INFO %s" % (stamp(7 * 86400 + 5 * 3600 - 38), api_ns),
    "%s WARN namespace budget-worker: %s not loaded (%s); serving built-in defaults" % (stamp(7 * 86400 + 5 * 3600 - 38), TOML, error),
]
with open("/var/log/settingsd/settingsd.log", "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
PY

# the logs of the healthy minute of this stand are not part of the story
: > /var/log/budget-worker/worker.log
: > /var/log/access-api/api.log
: > /var/log/usage-meter/meter.log
redis-cli -h 127.0.0.1 -p 6379 --scan --pattern 'access:*' </dev/null 2>/dev/null | while read -r key; do
  redis-cli -h 127.0.0.1 -p 6379 del "$key" </dev/null >/dev/null 2>&1
done

service settingsd start >/dev/null 2>&1
i=0; f=
while [ $i -lt 30 ]; do
  f=$(flag)
  [ "$f" = "false" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$f" = "false" ] || { echo "break: FAILED, settingsd does not serve the defaults (flag=$f)" >&2; exit 1; }
grep -q 'budget-worker.toml not loaded' /var/log/settingsd/settingsd.log || { echo "break: FAILED, settingsd did not log the load failure" >&2; exit 1; }

# the worker goes on with the queue; the gateways come back when the worker has written the stale states, so that
# nobody sees these customers allowed in between
service budget-worker start >/dev/null 2>&1
i=0; stale=0
while [ $i -lt 90 ]; do
  stale=0
  for c in $AFFECTED; do
    redis-cli -h 127.0.0.1 -p 6379 get "access:$c" </dev/null 2>/dev/null | grep -q '"allowed": false' && stale=$((stale + 1))
  done
  [ "$stale" = "9" ] && break
  i=$((i + 1)); sleep 1
done
[ "$stale" = "9" ] || { echo "break: FAILED, the worker wrote the stale state for $stale of 9 customers in 90 s" >&2; exit 1; }
service usage-meter start >/dev/null 2>&1

# the damage must be visible: every customer who had exhausted last month's budget is refused, the queue is long
refused=0
for c in $AFFECTED; do
  curl -q -s --max-time 4 "$API/v1/access/$c" </dev/null 2>/dev/null | grep -q '"allowed": false' && refused=$((refused + 1))
done
qlen=$(redis-cli -h 127.0.0.1 -p 6379 llen "$QUEUE" </dev/null 2>/dev/null)
{ [ "$refused" = "9" ] && [ "${qlen:-0}" -gt 5000 ]; } || { echo "break: FAILED, $refused of 9 customers are refused, the queue holds ${qlen:-?} events" >&2; exit 1; }
pgrep -f /opt/usage-meter/meter.py >/dev/null 2>&1 || { echo "break: FAILED, usage-meter did not start" >&2; exit 1; }
echo "break: done ($refused customers refused on a stale status, $qlen budget updates queued)"
