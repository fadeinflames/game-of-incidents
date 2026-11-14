#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/nginx /run/sudo /run/lock
service entitlements start >/dev/null 2>&1 || true
service engine-std start >/dev/null 2>&1 || true
service engine-pro start >/dev/null 2>&1 || true
service catalog-api start >/dev/null 2>&1 || true
# nginx starts once its upstreams listen, so that its error logs begin empty
i=0
while [ $i -lt 60 ]; do
  curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8080/healthz 2>/dev/null </dev/null \
    && curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:9100/healthz 2>/dev/null </dev/null && break
  i=$((i + 1)); sleep 0.5
done
service nginx start >/dev/null 2>&1 || true
# the users come once the engine list is served through the public entry point
i=0
while [ $i -lt 60 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 2 -H 'X-Account: acc-1064' -A 'translator-cli/1.4.1' http://127.0.0.1/v1/engines 2>/dev/null </dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 0.5
done
service loadgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
