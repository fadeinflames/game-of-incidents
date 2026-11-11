#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o postgres -g postgres -m 2775 /run/postgresql
service postgresql start >/dev/null 2>&1 || true
i=0
while ! pg_isready -q -h /run/postgresql 2>/dev/null && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
service storage-api start >/dev/null 2>&1 || true
service changefeed start >/dev/null 2>&1 || true
service trafficgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
