#!/bin/sh
# SECRET reference solution: the runners get a pause between attempts that grows and is partly random, and the new
# settings are applied with a reload (SIGHUP), runner by runner. The gateway, both Redis instances and the notifier are
# not touched. Then wait until every runner holds its pool again and the notifier is back.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONF=/etc/runner/runner.conf
QUEUE=127.0.30.11
STORE=127.0.30.12

sed -i -e 's/^redial_pause_ms *=.*/redial_pause_ms = 1000/' \
       -e 's/^redial_backoff *=.*/redial_backoff = 2/' \
       -e 's/^redial_jitter *=.*/redial_jitter = 0.5/' "$CONF"
grep -q '^redial_pause_ms = 1000$' "$CONF" && grep -q '^redial_backoff = 2$' "$CONF" && grep -q '^redial_jitter = 0.5$' "$CONF" \
  || { echo "solve: the settings were not changed" >&2; exit 1; }

for n in 1 2 3 4 5 6 7 8; do
  service "runner-$n" reload >/dev/null 2>&1 </dev/null || service "runner-$n" restart >/dev/null 2>&1 </dev/null
done

runners() { redis-cli -h "$QUEUE" -p 6379 client list </dev/null 2>/dev/null | grep -c ' name=runner-[1-8]/' || true; }
sent() { v=$(redis-cli -h "$STORE" -p 6379 get notify:sent </dev/null 2>/dev/null || true); case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac; }

# the abandoned attempts drain from the gateway's queue in a few seconds, then the pools come back one by one and the
# notifier gets through
s0=$(sent)
i=0; r=0; s1=$s0
while [ $i -lt 120 ]; do
  r=$(runners); s1=$(sent)
  [ "$r" -ge 64 ] && [ "$s1" -gt "$s0" ] && break
  i=$((i + 1)); sleep 1
done
[ "$r" -ge 64 ] && [ "$s1" -gt "$s0" ] || { echo "solve: not recovered in 120 s (runner connections=$r, notifications sent $s0 -> $s1)" >&2; exit 1; }
echo "solve: done (runner connections=$r, the notifier delivers again)"
