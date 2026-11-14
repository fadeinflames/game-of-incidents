#!/bin/sh
# SECRET reference solution:
#   1. the settings file of budget-worker parses again (true instead of yes), settingsd reloads it: the safeguard is on;
#      the batch size goes up so that the backlog is worked through in a minute instead of hours;
#   2. the worker takes the new settings (a restart makes it certain), the queue drains;
#   3. only then the cached access statuses are removed: access-api computes them anew from the budget data.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
TOML=/etc/settingsd/namespaces/budget-worker.toml
SETTINGS=http://127.0.0.1:8500/v1/settings/budget-worker
QUEUE=queue:budget-updates
rc() { redis-cli -h 127.0.0.1 -p 6379 "$@" </dev/null; }

# 1
sed -i 's/^discard_state_before_reset *=.*/discard_state_before_reset = true/; s/^batch_size *=.*/batch_size = 500/' "$TOML"
service settingsd reload >/dev/null 2>&1
i=0; served=
while [ $i -lt 20 ]; do
  served=$(curl -q -s --max-time 4 "$SETTINGS" </dev/null 2>/dev/null || true)
  case "$served" in *'"access.discard_state_before_reset": true'*'"queue.batch_size": 500'*|*'"queue.batch_size": 500'*'"access.discard_state_before_reset": true'*) break ;; esac
  i=$((i + 1)); sleep 0.5
done
case "$served" in *'"access.discard_state_before_reset": true'*) ;; *) echo "solve: settingsd does not serve the safeguard: $served" >&2; exit 1 ;; esac

# 2
service budget-worker restart >/dev/null 2>&1
i=0; qlen=
while [ $i -lt 200 ]; do
  qlen=$(rc llen "$QUEUE")
  [ "${qlen:-99999}" -le 5 ] && break
  i=$((i + 1)); sleep 1
done
[ "${qlen:-99999}" -le 5 ] || { echo "solve: the queue still holds $qlen events" >&2; exit 1; }
grep -q 'access.discard_state_before_reset=true' /var/log/budget-worker/worker.log || { echo "solve: the worker does not have the safeguard" >&2; exit 1; }

# 3: only the statuses; the queue, the sessions and the counters stay
rc --scan --pattern 'access:*' | while read -r key; do rc del "$key" >/dev/null; done
sleep 1
answer=$(curl -q -s --max-time 4 http://127.0.0.1:8080/v1/access/1017 </dev/null)
case "$answer" in *'"allowed": true'*) ;; *) echo "solve: customer 1017 is still refused: $answer" >&2; exit 1 ;; esac
echo "solve: done (safeguard on, queue drained, stale statuses removed)"
