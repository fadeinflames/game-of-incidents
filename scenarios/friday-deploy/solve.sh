#!/bin/sh
# SECRET reference solution: after a deploy broke prod, roll back first and investigate later.
set -eu
kubectl rollout undo deploy/api-backend >/dev/null
kubectl rollout status deploy/api-backend --timeout=120s >/dev/null
# let the traffic window (60 s) fill with healthy answers and the OOM window (2 min) pass
sleep 130
echo "solve: done"
