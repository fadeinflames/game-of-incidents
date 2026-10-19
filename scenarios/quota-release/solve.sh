#!/bin/sh
# SECRET reference solution: free CPU in the namespace by scaling the batch worker down to its agreed minimum (2).
# Quota and LimitRange stay as they are.
set -eu
kubectl -n production scale deploy/worker --replicas=2 >/dev/null
# terminating worker pods are still charged to the quota until they are gone (up to the 30 s grace period)
i=0
while [ $i -lt 15 ] && [ "$(kubectl -n production get pods -l app=worker -o name 2>/dev/null | wc -l)" -gt 2 ]; do i=$((i + 1)); sleep 3; done
# The stuck ReplicaSet retries pod creation with an exponential backoff that freeing the quota does not reset: right
# after the break the next retry is seconds away, after ten minutes of diagnosis it is minutes away. So do not wait for
# it: restart the rollout, the new ReplicaSet starts without the accumulated backoff. Only while no pod of the new
# release exists, though: restarting a rollout that has already moved makes it replace its own pods one by one, each
# holding its quota share for the 30 s grace period.
updated=$(kubectl -n production get deploy report-api -o jsonpath='{.status.updatedReplicas}' 2>/dev/null) || updated=
if [ "${updated:-0}" = "0" ]; then kubectl -n production rollout restart deploy/report-api >/dev/null; fi
kubectl -n production rollout status deploy/report-api --timeout=120s >/dev/null
echo "solve: done"
