#!/bin/sh
# SECRET reference solution: take the current CA from the security bundle, put it into the Prometheus trust store,
# restart Prometheus (the mounted Secret would be picked up by itself after the kubelet sync, within a minute or two;
# the restart makes it immediate and deterministic).
set -eu
kubectl -n security get configmap observability-ca -o jsonpath='{.data.ca-next\.crt}' > /tmp/ca-current.crt
kubectl -n monitoring create secret generic remote-write-ca --from-file=ca.crt=/tmp/ca-current.crt --dry-run=client -o yaml | kubectl -n monitoring apply -f - >/dev/null
kubectl -n monitoring annotate secret remote-write-ca ca/version="2" --overwrite >/dev/null
kubectl -n monitoring rollout restart deploy/prometheus >/dev/null
kubectl -n monitoring rollout status deploy/prometheus --timeout=180s >/dev/null
# first scrape + first remote_write batch
sleep 45
echo "solve: done"
