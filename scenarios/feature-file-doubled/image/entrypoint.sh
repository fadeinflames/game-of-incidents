#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/nginx /run/sudo /run/lock && install -d -o postgres -g postgres -m 2775 /run/postgresql
service postgresql start >/dev/null 2>&1 || true
service access-rollout start >/dev/null 2>&1 || true
service featuregen start >/dev/null 2>&1 || true
# the proxy needs a features file to start: wait for the generator's first cycle
i=0
while [ ! -s /var/lib/edge/features/current.json ] && [ $i -lt 60 ]; do i=$((i + 1)); sleep 0.5; done
service edge-proxy start >/dev/null 2>&1 || true
service nginx start >/dev/null 2>&1 || true
service trafficgen start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
