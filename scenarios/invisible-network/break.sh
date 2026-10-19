#!/bin/sh
# SECRET. 08:30, the network team "hardens" the prod-workloads security group: cross-zone ingress is now denied.
# The canary (everything in one zone) passed. At 14:30 peak traffic, order-service (zones a and d) cannot reach
# payment-service (zone b): timeouts, then the circuit breaker ejects every payment endpoint.
# Time budget: the waits share one deadline, the whole script stays well under the 240 s break limit.
set -u
t0=$(date +%s)
left() { r=$(( $1 - ($(date +%s) - t0) )); [ "$r" -lt 5 ] && r=5; echo "$r"; }
kubectl -n production rollout status deploy/payment-service --timeout="$(left 70)s" >/dev/null 2>&1 || true
kubectl -n production rollout status deploy/order-service --timeout="$(left 70)s" >/dev/null 2>&1 || true
kubectl -n kube-system rollout status daemonset/sg-agent --timeout="$(left 70)s" >/dev/null 2>&1 || true

kubectl -n kube-system patch configmap security-groups --type=merge -p '{"data":{"prod-workloads.rules":"# security group \"prod-workloads\", attached to all worker nodes\n# syntax: <direction> <proto> <scope> <action>\n# NET-8802 hardening: only same-zone east-west traffic (canary ok)\ningress tcp same-zone allow\ningress tcp cross-zone deny\negress  any any       allow\n"}}' >/dev/null
kubectl -n kube-system annotate configmap security-groups change-ticket=NET-8802 changed-at="08:30 network-team" --overwrite >/dev/null

# wait until the outage is real: order-service ejected payment endpoints and customers see errors
ejected=0; rate=""
while [ $(( $(date +%s) - t0 )) -lt 190 ]; do
  ejected=0
  for p in $(kubectl -n production get pods -l app=order-service -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    n=$(kubectl -n production exec "$p" -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:8080/breaker",timeout=3)); print(sum(1 for e in d["breaker"] if e["status"]=="EJECTED"))' 2>/dev/null | tr -d '\r')
    ejected=$((ejected + ${n:-0}))
  done
  rate=$(kubectl -n production exec deploy/frontend -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); print(d["success_rate"] if d["success_rate"] is not None else 1)' 2>/dev/null | tr -d '\r')
  low=$(printf '%s' "${rate:-1}" | awk '{print ($1 < 0.9) ? 1 : 0}')
  if [ "$ejected" -ge 2 ] && [ "$low" = "1" ]; then echo "break: done (ejected endpoints: $ejected, success rate: $rate)"; exit 0; fi
  sleep 3
done
echo "break: FAILED (ejected=${ejected:-?}, rate=${rate:-?})" >&2
exit 1
