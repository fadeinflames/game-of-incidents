#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock
# the history that comes with the image ends "a few minutes ago"
/usr/local/sbin/stand-init >/dev/null 2>&1 || true
service redis-balances start >/dev/null 2>&1 || true
i=0
while [ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null </dev/null)" != "PONG" ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
service redis-balances-r1 start >/dev/null 2>&1 || true
service redis-balances-r2 start >/dev/null 2>&1 || true
# the worker starts when both replicas have caught up
i=0
while [ $i -lt 60 ]; do
  up=$(redis-cli -h 127.0.0.1 -p 6379 info replication 2>/dev/null </dev/null | grep -c 'state=online')
  [ "$up" -ge 2 ] && break
  i=$((i + 1)); sleep 0.5
done
service cardproc start >/dev/null 2>&1 || true
i=0
while ! curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8090/healthz </dev/null && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.5; done
service billing-worker start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
