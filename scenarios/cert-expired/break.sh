#!/bin/sh
# SECRET. Two months ago someone "hardened" the ingress controller: HTTPS only, port 80 removed from its Service.
# HTTP-01 renewals have been failing ever since; last night the certificate expired and cert-manager's re-issue
# cannot pass the challenge either. The site now serves the controller's fake certificate.
set -u
# One wall-clock budget for the whole script: prod kills break.sh at 300 s (BREAK_TIMEOUT_MS; the dev default and
# `wom scenario test` allow only 240 s). The first certificate (issued by the acme-bootstrap job) may take up to 195 s
# of it, the rest is kept for the break itself; everything ends by 270 s.
start=$(date +%s)
elapsed() { echo $(( $(date +%s) - start )); }
cert_ready() { kubectl -n production get certificate shop-tls -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null; }

n=0
until [ "$(cert_ready)" = "True" ]; do
  if [ "$(elapsed)" -ge 195 ]; then
    echo "break: FAILED, initial certificate not Ready after $(elapsed) s" >&2
    kubectl -n production get job acme-bootstrap >&2
    kubectl -n production logs job/acme-bootstrap --tail=10 >&2 2>&1
    # a solver pod stuck in ImagePullBackOff (image missing from environment.images) shows up here
    kubectl -n production get pods,challenges >&2 2>&1
    exit 1
  fi
  n=$((n + 1))
  [ $((n % 10)) -eq 0 ] && echo "break: waiting for the initial certificate ($(elapsed) s)" >&2
  sleep 3
done
echo "break: initial certificate Ready after $(elapsed) s" >&2

idx=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{range .spec.ports[*]}{.name}{"\n"}{end}' | awk '$1=="http"{print NR-1}')
[ -n "$idx" ] && kubectl -n ingress-nginx patch svc ingress-nginx-controller --type=json -p="[{\"op\":\"remove\",\"path\":\"/spec/ports/$idx\"}]" >/dev/null
kubectl -n ingress-nginx annotate svc ingress-nginx-controller change-cause="SEC-2210: HTTPS only, drop plain HTTP (2 months ago)" --overwrite >/dev/null

# "the certificate expired": the secret is gone, cert-manager must issue anew, and the challenge cannot pass
kubectl -n production delete secret shop-tls >/dev/null 2>&1 || true
reason=""; ready=""
while [ "$(elapsed)" -lt 270 ]; do
  reason=$(kubectl -n production get challenges -o jsonpath='{.items[0].status.reason}' 2>/dev/null)
  ready=$(cert_ready)
  case "$reason" in *self\ check*|*connection\ refused*|*timeout*|*error*) [ "$ready" != "True" ] && { echo "break: done in $(elapsed) s (certificate Ready=$ready, challenge: ${reason%%. *})"; exit 0; };; esac
  sleep 4
done
echo "break: FAILED after $(elapsed) s (ready=${ready:-?}, challenge reason=${reason:-none})" >&2
exit 1
