#!/bin/sh
# SECRET reference solution: allow cross-zone ingress again in the security group (the agent applies it within 10 s),
# then reset the circuit breakers by restarting order-service, then let the traffic window recover.
set -eu
kubectl -n kube-system patch configmap security-groups --type=merge -p '{"data":{"prod-workloads.rules":"# security group \"prod-workloads\", attached to all worker nodes\n# syntax: <direction> <proto> <scope> <action>\n# NET-8802 rolled back by on-call (INC-5120): cross-zone east-west is required for order -> payment\ningress tcp same-zone allow\ningress tcp cross-zone allow\negress  any any       allow\n"}}' >/dev/null
sleep 15
kubectl -n production rollout restart deploy/order-service >/dev/null
kubectl -n production rollout status deploy/order-service --timeout=120s >/dev/null
sleep 70
echo "solve: done"
