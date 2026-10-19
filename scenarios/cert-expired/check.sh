#!/bin/sh
# SECRET grader: a valid certificate from the ACME issuer is served again, renewals can work (port 80 back),
# nobody replaced the issuer with a self-signed one, cert-manager is intact.
ok_ready=false; msg_ready="Certificate production/shop-tls не Ready"
ok_valid=false; msg_valid="срок действия сертификата истёк или неизвестен"
ok_issuer=false; msg_issuer="сертификат выпущен не через ClusterIssuer letsencrypt-prod (самоподписанный не считается)"
ok_served=false; msg_served="ingress отдаёт не тот сертификат (fake certificate или чужой issuer)"
ok_http=false;  msg_http="у ingress-nginx-controller нет порта 80: следующий HTTP-01 снова упадёт"
ok_cm=false;    msg_cm="cert-manager не в полном составе"

ready=$(kubectl -n production get certificate shop-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
[ "$ready" = "True" ] && { ok_ready=true; msg_ready="Certificate shop-tls Ready"; }

na=$(kubectl -n production get certificate shop-tls -o jsonpath='{.status.notAfter}' 2>/dev/null)
now=$(date -u +%s); exp=$(date -d "$na" +%s 2>/dev/null || echo 0)
[ "$exp" -gt "$now" ] && { ok_valid=true; msg_valid="сертификат действителен до $na"; }

iref=$(kubectl -n production get certificate shop-tls -o jsonpath='{.spec.issuerRef.kind}/{.spec.issuerRef.name}' 2>/dev/null)
srv=$(kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.spec.acme.server}' 2>/dev/null)
[ "$iref" = "ClusterIssuer/letsencrypt-prod" ] && [ -n "$srv" ] && { ok_issuer=true; msg_issuer="выпущен через ClusterIssuer letsencrypt-prod (ACME)"; }

served=$(kubectl -n production exec deploy/shop-frontend -- python3 -c 'import ssl, socket
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection(("ingress-nginx-controller.ingress-nginx.svc", 443), timeout=5), server_hostname="shop.production.svc.cluster.local")
pem = ssl.DER_cert_to_PEM_cert(s.getpeercert(True)); open("/tmp/c.pem", "w").write(pem)
d = ssl._ssl._test_decode_cert("/tmp/c.pem"); print("|".join(v for rdn in d["issuer"] for k, v in rdn), "|", d["notAfter"])' 2>/dev/null | tr -d '\r')
case "$served" in *Pebble*) ok_served=true; msg_served="ingress отдаёт сертификат от ACME CA (${served%%|*})";; *Fake*) msg_served="ingress отдаёт Kubernetes Ingress Controller Fake Certificate";; esac

if kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[*].port}' 2>/dev/null | tr ' ' '\n' | grep -qx 80; then ok_http=true; msg_http="порт 80 у ingress-nginx-controller на месте (HTTP-01 может проходить)"; fi

c1=$(kubectl -n cert-manager get deploy cert-manager -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
c2=$(kubectl -n cert-manager get deploy cert-manager-webhook -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
c3=$(kubectl -n cert-manager get deploy cert-manager-cainjector -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${c1:-0}" = "1" ] && [ "${c2:-0}" = "1" ] && [ "${c3:-0}" = "1" ] && { ok_cm=true; msg_cm="cert-manager: controller, webhook, cainjector Ready"; }

passed=false
if $ok_ready && $ok_valid && $ok_issuer && $ok_served && $ok_http && $ok_cm; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"certificate-ready","ok":%s,"message":"%s"},' "$ok_ready" "$msg_ready"
printf '{"id":"certificate-valid","ok":%s,"message":"%s"},' "$ok_valid" "$msg_valid"
printf '{"id":"acme-issuer","ok":%s,"message":"%s"},' "$ok_issuer" "$msg_issuer"
printf '{"id":"served-certificate","ok":%s,"message":"%s"},' "$ok_served" "$msg_served"
printf '{"id":"http01-possible","ok":%s,"message":"%s"},' "$ok_http" "$msg_http"
printf '{"id":"cert-manager-intact","ok":%s,"message":"%s"}' "$ok_cm" "$msg_cm"
printf ']}\n'
