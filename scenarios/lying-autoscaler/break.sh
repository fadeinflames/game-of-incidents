#!/bin/sh
# SECRET. Release 3.4 turns on peer gossip: each replica syncs with every other replica once a second. CPU per pod now
# grows with the replica count, the HPA (CPU, target 50 %) reads that as load and scales up, which adds peers, which
# adds CPU... until maxReplicas. Self-amplifying loop.
# Worst-case budget (the platform allows 240 s): 30 + 40 + 40 + 40 + 60 s of waiting.
set -u
kubectl rollout status deploy/checkout-api --timeout=30s >/dev/null 2>&1 || true
kubectl -n kube-system rollout status deploy/metrics-server --timeout=40s >/dev/null 2>&1 || true
# the HPA can only run away once metrics flow: wait for `kubectl top` before starting the clock
i=0
while [ $i -lt 20 ]; do
  kubectl top pods -l app=checkout-api --no-headers >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 2
done

kubectl patch configmap checkout-config --type=merge -p '{"data":{"PEER_GOSSIP":"on"}}' >/dev/null
kubectl annotate deploy/checkout-api kubernetes.io/change-cause="release 3.4: cart consistency across pods (peer gossip)" --overwrite >/dev/null
kubectl rollout restart deploy/checkout-api >/dev/null
kubectl rollout status deploy/checkout-api --timeout=40s >/dev/null 2>&1 || true

# the HPA needs minutes of metrics history before it acts; the storm has been running for 20 minutes in the story,
# so bring the Deployment to where the loop already took it. With gossip on, the HPA keeps it there (or higher).
kubectl scale deploy/checkout-api --replicas=9 >/dev/null
i=0
while [ $i -lt 30 ]; do
  ready=$(kubectl get deploy checkout-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  if [ "${ready:-0}" -ge 9 ]; then echo "break: done (checkout-api at $ready replicas, gossip on, HPA active)"; exit 0; fi
  i=$((i + 1)); sleep 2
done
echo "break: FAILED (ready=${ready:-?})" >&2
exit 1
