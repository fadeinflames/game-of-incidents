#!/bin/sh
# SECRET. The frontend team ships "catalog v2" with client-side routing: an Ingress with a regex path /(.*) that rewrites every
# URL to /index.html (web-frontend has no SPA fallback of its own, so deleting this Ingress breaks /products/42).
# They added both hosts "so the app works on api.shop.local too". use-regex turns every location of a host into a regex
# one, and ingress-nginx orders them by path length: /(.*) is longer than /api and goes first, so
# api.shop.local/api/orders now returns index.html. Mobile clients get HTML instead of JSON.
# Worst-case budget (the platform allows 240 s): 45 + 30 + 30 + 90 s of waiting.
set -u
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=45s >/dev/null 2>&1 || true
kubectl rollout status deploy/api-service --timeout=30s >/dev/null 2>&1 || true
kubectl rollout status deploy/web-frontend --timeout=30s >/dev/null 2>&1 || true

cat <<'EOF' | kubectl apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: catalog-v2
  namespace: default
  annotations:
    owner: frontend-team
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /index.html
    change-cause: "catalog v2: SPA routing, serve the app on both hosts"
spec:
  ingressClassName: nginx
  rules:
    - host: shop.local
      http:
        paths:
          - path: /(.*)
            pathType: ImplementationSpecific
            backend:
              service: { name: web-frontend, port: { number: 80 } }
    - host: api.shop.local
      http:
        paths:
          - path: /(.*)
            pathType: ImplementationSpecific
            backend:
              service: { name: web-frontend, port: { number: 80 } }
EOF

# wait until the symptom is real: api.shop.local/api/orders answers HTML
i=0
while [ $i -lt 30 ]; do
  ctype=$(kubectl exec deploy/clients -- python3 -c 'import urllib.request as u
try: print(u.urlopen(u.Request("http://ingress-nginx-controller.ingress-nginx.svc/api/orders", headers={"Host":"api.shop.local"}), timeout=4).headers.get("Content-Type",""))
except Exception as e: print("ERR", e)' 2>/dev/null | tr -d '\r')
  case "$ctype" in *text/html*) echo "break: done (api.shop.local/api/orders -> $ctype)"; exit 0;; esac
  i=$((i + 1)); sleep 3
done
echo "break: FAILED (content-type: ${ctype:-?})" >&2
exit 1
