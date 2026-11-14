#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o git -g git /run/git-housekeeping
install -o git -g git -m 0644 /dev/null /run/git-housekeeping/lock
# the history that comes with the image ends "now"
/usr/local/sbin/stand-init >/dev/null 2>&1 || true
service gitstored start >/dev/null 2>&1 || true
i=0
while ! curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8075/health </dev/null && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
service mergeq start >/dev/null 2>&1 || true
service cron start >/dev/null 2>&1 || true
service loadgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
