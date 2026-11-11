#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock /run/haproxy
service forum-web1 start >/dev/null 2>&1 || true
service forum-web2 start >/dev/null 2>&1 || true
service haproxy start >/dev/null 2>&1 || true
service trafficgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
