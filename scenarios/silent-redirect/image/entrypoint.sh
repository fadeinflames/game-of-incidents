#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/nginx /run/sudo /run/lock
service site-backends start >/dev/null 2>&1 || true
# nginx and the visitors come after the applications are listening (the last port of the table answers)
i=0
while [ $i -lt 40 ]; do
  curl -q -s -o /dev/null --max-time 1 http://127.0.0.1:9216/ </dev/null 2>/dev/null && break
  i=$((i + 1)); sleep 0.25
done
service nginx start >/dev/null 2>&1 || true
service trafficgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
