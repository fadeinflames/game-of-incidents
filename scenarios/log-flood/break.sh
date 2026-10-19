#!/bin/sh
# SECRET. "Let's debug the bad recommendations in prod for an hour": DEBUG_PAYLOAD=on. Every request now logs ~200 KB of
# features; at 20 rps (~4 MB/s in total, a third per pod) a pod's 64 Mi log volume fills in under a minute, kubelet evicts the pod, the Deployment makes a new
# one, the shipper never catches up. Evicted pods pile up, customers get errors while pods churn.
set -u
kubectl rollout status deploy/recommendation-api --timeout=120s >/dev/null 2>&1 || true
kubectl rollout status deploy/traffic --timeout=120s >/dev/null 2>&1 || true

kubectl patch configmap recommendation-config --type=merge -p '{"data":{"DEBUG_PAYLOAD":"on"}}' >/dev/null
kubectl annotate deploy/recommendation-api kubernetes.io/change-cause="ml-team: enable debug payload to investigate bad recs (temporary)" --overwrite >/dev/null
kubectl rollout restart deploy/recommendation-api >/dev/null
kubectl rollout status deploy/recommendation-api --timeout=120s >/dev/null 2>&1 || true

# wait until the symptom is real: at least 2 evicted pods
i=0
while [ $i -lt 60 ]; do
  evicted=$(kubectl get pods -l app=recommendation-api -o jsonpath='{range .items[*]}{.status.reason}{"\n"}{end}' 2>/dev/null | grep -c Evicted)
  if [ "$evicted" -ge 2 ]; then echo "break: done (evicted pods: $evicted)"; exit 0; fi
  i=$((i + 1)); sleep 3
done
echo "break: FAILED, no evictions after 3 minutes (evicted=${evicted:-?})" >&2
exit 1
