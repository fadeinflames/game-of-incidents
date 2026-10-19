#!/bin/sh
# ca-publisher job: publish the CA bundles from the image into the cluster (ConfigMaps in namespace security)
# and seed the Prometheus trust store with CA #1. Runs once at cluster start with a tiny RBAC scope.
set -eu
kubectl -n security create configmap observability-ca --from-file=ca.crt=/certs/ca1/ca.crt --from-file=ca-next.crt=/certs/ca2/ca.crt --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n security annotate configmap observability-ca ca/current="1" ca/next="2" --overwrite >/dev/null
kubectl -n monitoring create secret generic remote-write-ca --from-file=ca.crt=/certs/ca1/ca.crt --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n monitoring annotate secret remote-write-ca ca/version="1" --overwrite >/dev/null
echo "ca-publisher: security/observability-ca (current=1, next=2) and monitoring/remote-write-ca (1) published"
