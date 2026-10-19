#!/bin/sh
# PID 1: restore the seeded cluster onto the (empty) tmpfs data partition, start services, idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock && install -d -o postgres -g postgres -m 2775 /run/postgresql
if [ ! -d /var/lib/postgresql/15 ]; then
  cp -a /usr/local/lib/.pgboot/. /var/lib/postgresql/
fi
service postgresql start >/dev/null 2>&1 || true
service app start >/dev/null 2>&1 || true
service cron start >/dev/null 2>&1 || true
# the data directory is restored and the services are up: break.sh waits for this marker before it touches the partition
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
