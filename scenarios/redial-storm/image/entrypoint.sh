#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock /run/haproxy

ping() { [ "$(redis-cli -h "$1" -p 6379 ping 2>/dev/null </dev/null)" = "PONG" ]; }
# connections a runner holds in the queue, as the queue sees them
pool() { redis-cli -h 127.0.30.11 -p 6379 client list 2>/dev/null </dev/null | grep -c "name=$1/"; }

service queue-redis start >/dev/null 2>&1 || true
service notify-redis start >/dev/null 2>&1 || true
i=0
while [ $i -lt 60 ]; do ping 127.0.30.11 && ping 127.0.30.12 && break; i=$((i + 1)); sleep 0.5; done
service seg-gw start >/dev/null 2>&1 || true
i=0
while [ $i -lt 60 ]; do
  [ "$(redis-cli -h 127.0.20.12 -p 6380 ping 2>/dev/null </dev/null)" = "PONG" ] && break
  i=$((i + 1)); sleep 0.5
done
service scheduler start >/dev/null 2>&1 || true
# the runners come up one after another, each when the previous one holds all its connections
for n in 1 2 3 4 5 6 7 8; do
  service "runner-$n" start >/dev/null 2>&1 || true
  i=0
  while [ $i -lt 40 ]; do
    [ "$(pool "runner-$n")" -ge 8 ] && break
    i=$((i + 1)); sleep 0.5
  done
  sleep 1
done
service notifier start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
