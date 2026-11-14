#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o postgres -g postgres -m 2775 /run/postgresql
service postgresql start >/dev/null 2>&1 || true
i=0
while ! pg_isready -q -h /run/postgresql 2>/dev/null && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
service redis start >/dev/null 2>&1 || true
i=0
while [ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null </dev/null)" != "PONG" ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
# the monthly reset was "last night": periods, usage and the cron entry are dated at first boot
/usr/local/sbin/stand-init >/dev/null 2>&1 || true
service settingsd start >/dev/null 2>&1 || true
i=0
while ! curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8500/healthz </dev/null && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.5; done
service access-api start >/dev/null 2>&1 || true
i=0
while ! curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8080/healthz </dev/null && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.5; done
service budget-worker start >/dev/null 2>&1 || true
service usage-meter start >/dev/null 2>&1 || true
service cron start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
