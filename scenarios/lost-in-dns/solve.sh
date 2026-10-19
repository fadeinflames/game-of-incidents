#!/bin/sh
# SECRET reference solution: keep CoreDNS restricted, but let it talk out: DNS to upstreams and the API server.
set -eu
cat <<'EOF' | kubectl apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: coredns-hardening
  namespace: kube-system
  annotations:
    owner: network-team
    change-ticket: NET-8811
    fixed-by: "on-call INC-5201: egress for upstream DNS and the API server was missing"
spec:
  podSelector:
    matchLabels: { k8s-app: kube-dns }
  policyTypes: [Ingress, Egress]
  ingress:
    - ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
  egress:
    - ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - ports:
        - { protocol: TCP, port: 443 }
        - { protocol: TCP, port: 6443 }
EOF
# the 60 s resolution window must fill with successes
sleep 70
echo "solve: done"
