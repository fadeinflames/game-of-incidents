#!/bin/sh
# acme-bootstrap job: cert-manager's CRDs and webhook come up a minute after `kubectl apply`, so the ClusterIssuer and
# the Certificate are created here, once everything is ready, from /bootstrap/*.yaml. Then it waits for the first
# certificate to be issued (the state the on-call finds "two months ago").
set -u
log() { echo "$(date -u +%FT%TZ) bootstrap: $*"; }
i=0
until kubectl get crd clusterissuers.cert-manager.io certificates.cert-manager.io >/dev/null 2>&1 && \
      [ "$(kubectl -n cert-manager get deploy cert-manager-webhook -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = "1" ] && \
      [ "$(kubectl -n cert-manager get deploy cert-manager -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = "1" ] && \
      [ "$(kubectl -n acme get deploy pebble -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = "1" ] && \
      [ "$(kubectl -n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = "1" ]; do
  i=$((i + 1)); [ $i -gt 120 ] && { log "giving up waiting for cert-manager/pebble/ingress"; exit 1; }
  sleep 3
done
log "cert-manager, pebble and ingress are ready; applying issuer and certificate"
i=0
until kubectl apply -f /bootstrap/ >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -gt 30 ] && { log "apply keeps failing"; kubectl apply -f /bootstrap/ 2>&1 | tail -3; exit 1; }
  sleep 4
done
log "waiting for the first issuance"
i=0
until [ "$(kubectl -n production get certificate shop-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; do
  i=$((i + 1)); [ $i -gt 60 ] && { log "certificate not ready after 3 min:"; kubectl -n production describe certificate shop-tls | tail -12; kubectl -n production get challenges -o wide 2>/dev/null; exit 1; }
  sleep 3
done
log "certificate shop-tls issued: $(kubectl -n production get certificate shop-tls -o jsonpath='{.status.notAfter}')"
