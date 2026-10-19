#!/bin/sh
# SECRET reference solution: timeout + fallback on the proxy, timeout on the order-service call, restart to free stuck threads.
set -eu
kubectl set env deploy/payment-proxy ACQUIRER_TIMEOUT=2 FALLBACK_ACQUIRER=true >/dev/null
kubectl rollout status deploy/payment-proxy --timeout=120s >/dev/null
kubectl set env deploy/order-service PAYMENT_TIMEOUT=5 >/dev/null
kubectl rollout status deploy/order-service --timeout=180s >/dev/null
sleep 5
echo "solve: done"
