#!/bin/sh
# SECRET reference solution: put the Secret reference back, then restart. The fixed template is identical to revision 1,
# so the Deployment would just re-adopt the old ReplicaSet and its running pods (still API_TIMEOUT=10); env is read at
# pod start, hence the explicit rollout restart.
set -eu
kubectl patch deploy web-app --type=json -p='[
  {"op":"add","path":"/spec/template/spec/containers/0/env/-","value":{"name":"DATABASE_PASSWORD","valueFrom":{"secretKeyRef":{"name":"postgres-secret","key":"password"}}}}]' >/dev/null
kubectl rollout status deploy/web-app --timeout=120s >/dev/null
kubectl rollout restart deploy/web-app >/dev/null
kubectl rollout status deploy/web-app --timeout=120s >/dev/null
echo "solve: done"
