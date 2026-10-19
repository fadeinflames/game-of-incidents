#!/bin/sh
# PID 1 of the sandbox: start services as daemons (SysV scripts), then idle.
# Restarting nginx/app from inside the sandbox must not kill PID 1 (no systemd here).
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/nginx /run/sudo /run/lock
service app start >/dev/null 2>&1 || true
service nginx start >/dev/null 2>&1 || true
# keep the container alive; exec'd shells and the grader are independent processes
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
