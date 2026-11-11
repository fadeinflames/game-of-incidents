#!/bin/sh
# SECRET reference solution: remove the injector webhook the mesh left behind, then nudge the two Deployments
# (their ReplicaSets have backed off after the failed creates and would retry only minutes later), then clean up
# the rest of the leftovers.
set -eu
kubectl delete mutatingwebhookconfiguration istio-sidecar-injector >/dev/null
kubectl -n shop rollout restart deploy/storefront >/dev/null
kubectl -n billing rollout restart deploy/invoicer >/dev/null
kubectl -n shop rollout status deploy/storefront --timeout=120s >/dev/null
kubectl -n billing rollout status deploy/invoicer --timeout=120s >/dev/null

# the rest of what the mesh left: injection labels, the copied root certificate, the Service, the API types
kubectl label namespace shop billing istio-injection- >/dev/null
kubectl -n shop delete configmap istio-ca-root-cert --ignore-not-found >/dev/null
kubectl -n billing delete configmap istio-ca-root-cert --ignore-not-found >/dev/null
kubectl delete namespace istio-system --wait=false >/dev/null
kubectl delete crd virtualservices.networking.istio.io destinationrules.networking.istio.io --wait=false >/dev/null
echo "solve: done"
