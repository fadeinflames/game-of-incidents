#!/bin/sh
# SECRET. 08:00, the network team applies a NetworkPolicy "for CoreDNS hardening": ingress 53 from anywhere is allowed,
# egress is not mentioned but policyTypes lists it -> deny all egress. CoreDNS can no longer forward corp.internal to the
# corporate DNS: cluster names keep resolving (served from the informer cache), partner names fail after the cache expires.
set -u
kubectl -n infra rollout status deploy/corp-dns --timeout=120s >/dev/null 2>&1 || true
kubectl -n shop rollout status deploy/external-api-proxy --timeout=120s >/dev/null 2>&1 || true
kubectl -n kube-system rollout restart deploy/coredns >/dev/null 2>&1 || true   # pick up the stub zone for sure
kubectl -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null 2>&1 || true

# the world before: corp names resolve
i=0
while [ $i -lt 30 ]; do
  ok=$(kubectl -n shop exec deploy/external-api-proxy -- python3 -c 'import socket
try: socket.getaddrinfo("payments-gateway.corp.internal", 443); print(1)
except OSError: print(0)' 2>/dev/null | tr -d '\r')
  [ "${ok:-0}" = "1" ] && break
  i=$((i + 1)); sleep 3
done

cat <<'EOF' | kubectl apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: coredns-hardening
  namespace: kube-system
  annotations:
    owner: network-team
    change-ticket: NET-8811
    description: "CoreDNS should only ever be talked to on 53; tests passed in staging"
spec:
  podSelector:
    matchLabels: { k8s-app: kube-dns }
  policyTypes: [Ingress, Egress]
  ingress:
    - ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
EOF

# wait until the symptom is real: corp.internal fails from the app while cluster names still resolve
i=0
while [ $i -lt 40 ]; do
  res=$(kubectl -n shop exec deploy/external-api-proxy -- python3 -c 'import socket
def r(n):
    try: socket.getaddrinfo(n, 443); return 1
    except OSError: return 0
print(r("payments-gateway.corp.internal"), r("backend-api.shop.svc.cluster.local"))' 2>/dev/null | tr -d '\r')
  if [ "$res" = "0 1" ]; then echo "break: done (corp.internal fails, cluster names resolve)"; exit 0; fi
  i=$((i + 1)); sleep 4
done
echo "break: FAILED (resolution corp/cluster: ${res:-?})" >&2
exit 1
