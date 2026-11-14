#!/bin/sh
# SECRET. The network team does a planned maintenance on the segment gateway: a restart, about two seconds of downtime.
# Every runner loses its eight connections to the queue at once and opens them again without a pause: 64 connection
# attempts against a gateway that sets up 16 new sessions per second. An attempt that waits in the gateway's listen
# queue for more than a second is abandoned by the runner, which then drops its whole pool and starts over. The gateway
# still has to accept every abandoned attempt, so its whole limit goes to dead connections: the storm keeps itself
# going, and the notifier, which uses the same gateway politely, cannot reach its store either.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
QUEUE=127.0.30.11
STORE=127.0.30.12
CHANGES=/var/log/seg-gw/changes.log

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 160 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 80 s" >&2; exit 1; }

runners() { redis-cli -h "$QUEUE" -p 6379 client list </dev/null 2>/dev/null | grep -c ' name=runner-[1-8]/'; }
counter() { v=$(redis-cli -h "$1" -p 6379 get "$2" </dev/null 2>/dev/null); case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac; }
accepted() {
  echo "show stat" | socat -t 2 stdio /run/haproxy/admin.sock 2>/dev/null | awk -F, '$1 == "seg-a" && $2 == "FRONTEND" { print $8 }'
}

# the stand must be healthy before it is broken: every runner holds its pool, jobs get done, the notifier delivers
d0=$(counter "$QUEUE" jobs:done); s0=$(counter "$STORE" notify:sent)
i=0; ok=0; r=0; d1=$d0; s1=$s0
while [ $i -lt 30 ]; do
  sleep 1
  r=$(runners); d1=$(counter "$QUEUE" jobs:done); s1=$(counter "$STORE" notify:sent)
  if [ "$r" -eq 64 ] && [ "$d1" -ge $((d0 + 20)) ] && [ "$s1" -gt "$s0" ]; then ok=1; break; fi
  i=$((i + 1))
done
[ $ok = 1 ] || { echo "break: FAILED, the stand is not healthy before the break (runner connections=$r, jobs done $d0 -> $d1, notifications sent $s0 -> $s1)" >&2; exit 1; }

# the change log of the network team: the previous restarts went unnoticed, the fleet was smaller then
stamp() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
{
  echo "$(stamp '97 days ago 10:02:11') CHG-3301 seg-gw: commissioning, policy NET-7.2 applied (16 new sessions per second, listen queue 64)"
  echo "$(stamp '61 days ago 14:30:05') CHG-3388 seg-gw: planned restart (package update), downtime 2 s. Result: gateway up, both backends UP, 24 client sessions re-established in 1 s"
  echo "$(stamp '33 days ago 14:31:47') CHG-3467 seg-gw: planned restart (certificate store), downtime 2 s. Result: gateway up, both backends UP, 24 client sessions re-established in 1 s"
  echo "$(stamp '12 days ago 11:15:20') CHG-3502 seg-gw: no change on the gateway. Note from the pipeline team: runners scaled from 3 to 8, expected client sessions 64"
  echo "$(stamp 'now') CHG-3540 seg-gw: planned restart (kernel parameters of the host), downtime 2 s. Result: gateway up, both backends UP, configuration unchanged"
} > "$CHANGES"
chmod 0644 "$CHANGES"

# the maintenance itself
service seg-gw restart >/dev/null 2>&1 </dev/null

# the gateway must be back
i=0; up=0
while [ $i -lt 20 ]; do
  [ -n "$(accepted)" ] && { up=1; break; }
  i=$((i + 1)); sleep 0.5
done
[ $up = 1 ] || { echo "break: FAILED, the gateway did not come back after the restart" >&2; exit 1; }

# the breakage must be visible and must stay: for 12 seconds in a row most runners have no pool, the notifier delivers
# nothing, and the gateway keeps accepting new sessions at its limit
sleep 8
i=0; calm=0; rmax=0; a1=$(accepted); s1=$(counter "$STORE" notify:sent)
while [ $i -lt 6 ]; do
  sleep 2
  r=$(runners)
  [ "$r" -gt "$rmax" ] && rmax=$r
  [ "$r" -gt 32 ] && calm=1
  i=$((i + 1))
done
a2=$(accepted); s2=$(counter "$STORE" notify:sent)
case "$a1$a2" in ''|*[!0-9]*) a1=0; a2=0 ;; esac
if [ $calm = 1 ] || [ $((a2 - a1)) -lt 120 ] || [ "$s2" -gt "$s1" ]; then
  echo "break: FAILED, no lasting storm (runner connections up to $rmax, notifications sent in 12 s: $((s2 - s1)), sessions accepted in 12 s: $((a2 - a1)))" >&2
  exit 1
fi
echo "break: done (runner connections: $rmax of 64, the notifier is cut off, the gateway accepts $(( (a2 - a1) / 12 )) sessions per second)"
