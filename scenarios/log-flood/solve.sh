#!/bin/sh
# SECRET reference solution: stop the flood at the source, restart the noisy pods, clear the evicted wreckage,
# give the shipper and the traffic window time to recover.
set -eu
kubectl patch configmap recommendation-config --type=merge -p '{"data":{"DEBUG_PAYLOAD":"off"}}' >/dev/null
kubectl rollout restart deploy/recommendation-api >/dev/null
kubectl rollout status deploy/recommendation-api --timeout=120s >/dev/null
kubectl delete pods -l app=recommendation-api --field-selector=status.phase=Failed >/dev/null 2>&1 || true
sleep 130
echo "solve: done"
