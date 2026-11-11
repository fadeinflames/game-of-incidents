#!/bin/sh
# Supervisor of the edge-proxy worker: a worker that exits is started again after a short pause.
child=""
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
while true; do
  /usr/bin/python3 /opt/edge-proxy/edge_proxy.py &
  child=$!
  wait "$child"
  rc=$?
  echo "$(date -u +%FT%TZ) WARN supervisor: worker exited with status $rc, restarting in 2s"
  sleep 2 &
  child=$!
  wait "$child"
done
