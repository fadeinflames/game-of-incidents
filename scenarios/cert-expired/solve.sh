#!/bin/sh
# SECRET reference solution: give HTTP-01 its port back (ACME needs :80 for the challenge, HTTPS-only is fine for
# everything else via a redirect), then let cert-manager finish the pending order.
set -eu
kubectl -n ingress-nginx patch svc ingress-nginx-controller --type=json -p='[{"op":"add","path":"/spec/ports/-","value":{"name":"http","port":80,"targetPort":"http","protocol":"TCP"}}]' >/dev/null
i=0
until [ "$(kubectl -n production get certificate shop-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "solve: certificate still not ready" >&2; kubectl -n production get challenges -o wide >&2 2>/dev/null; exit 1; }
  sleep 3
done
sleep 10
echo "solve: done"
