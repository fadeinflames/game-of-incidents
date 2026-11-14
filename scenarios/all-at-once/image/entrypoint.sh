#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o mysql -g mysql /run/mysqld
service mariadb start >/dev/null 2>&1 || true
i=0
while ! mysqladmin --no-defaults ping >/dev/null 2>&1 && [ $i -lt 90 ]; do i=$((i + 1)); sleep 1; done
# the history that comes with the image ends "a minute ago"
/usr/local/sbin/stand-init >/dev/null 2>&1 || true
service redis-queue start >/dev/null 2>&1 || true
i=0
while [ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null </dev/null)" != "PONG" ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
service alerts-api start >/dev/null 2>&1 || true
service jobrunner start >/dev/null 2>&1 || true
service advisory-feed start >/dev/null 2>&1 || true
i=0
while [ $i -lt 60 ]; do
  curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8080/health </dev/null \
    && [ "$(redis-cli -h 127.0.0.1 -p 6379 exists jobrunner:state 2>/dev/null </dev/null)" = "1" ] && break
  i=$((i + 1)); sleep 0.5
done
service loadgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
