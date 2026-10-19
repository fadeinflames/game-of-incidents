#!/bin/sh
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock /var/spool/cron/crontabs
service cron start >/dev/null 2>&1 || true
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
