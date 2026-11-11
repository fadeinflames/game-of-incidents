#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o mysql -g mysql /run/mysqld
service mariadb start >/dev/null 2>&1 || true
i=0
while ! mysqladmin --no-defaults ping >/dev/null 2>&1 && [ $i -lt 60 ]; do i=$((i + 1)); sleep 1; done
service tracker-api start >/dev/null 2>&1 || true
service cron start >/dev/null 2>&1 || true
service loadgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
