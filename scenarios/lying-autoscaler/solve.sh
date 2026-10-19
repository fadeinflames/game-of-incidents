#!/bin/sh
# SECRET reference solution: freeze first (stop the scheduling storm), then remove the amplifier (gossip off),
# then give the HPA back its job.
set -eu
kubectl patch hpa checkout-api --type=merge -p '{"spec":{"minReplicas":3,"maxReplicas":3}}' >/dev/null
kubectl patch configmap checkout-config --type=merge -p '{"data":{"PEER_GOSSIP":"off"}}' >/dev/null
kubectl rollout restart deploy/checkout-api >/dev/null
kubectl rollout status deploy/checkout-api --timeout=180s >/dev/null
kubectl patch hpa checkout-api --type=merge -p '{"spec":{"minReplicas":2,"maxReplicas":12}}' >/dev/null
# let the 60 s traffic window fill with healthy answers and the HPA settle
sleep 90
echo "solve: done"
