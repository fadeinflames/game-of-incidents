#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o mysql -g mysql /run/mysqld
service db-old start >/dev/null 2>&1 || true
service db-new start >/dev/null 2>&1 || true
for n in db-old db-new; do
  i=0
  while ! mysqladmin --no-defaults -S "/run/mysqld/$n.sock" ping >/dev/null 2>&1 && [ $i -lt 90 ]; do i=$((i + 1)); sleep 1; done
done
# the history that comes with the image ends "now"
/usr/local/sbin/stand-init >/dev/null 2>&1 || true
service tokend start >/dev/null 2>&1 || true
i=0
while ! curl -q -s -o /dev/null --max-time 2 http://127.0.0.1:8080/health </dev/null && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.5; done
service tablemover start >/dev/null 2>&1 || true
service cron start >/dev/null 2>&1 || true
service loadgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
