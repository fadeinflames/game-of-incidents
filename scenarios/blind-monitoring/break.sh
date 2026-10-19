#!/bin/sh
# SECRET. The yearly CA rotation: the central gateway now presents a certificate issued by CA #2, security published
# CA #2 as "current" in the cluster, but the Prometheus trust store (Secret monitoring/remote-write-ca) still holds CA #1.
# remote_write fails the TLS handshake, samples stop leaving the cluster, every central alert goes quiet.
# The gateway pod is recreated by the rotation, so its /status starts from zero: last_write_age_s is null, writes is 0.
# The script aims to finish within about 230 s (the regression gives break 240 s): the polling loops stop at fixed deadlines.
set -u
t0=$(date +%s)
elapsed() { echo $(( $(date +%s) - t0 )); }
# a wait of at most $2 seconds that never reaches past the $1 s mark of the whole script
tmo() { l=$(( $1 - $(elapsed) )); [ "$l" -lt 1 ] && l=1; [ "$l" -gt "$2" ] && l=$2; echo "${l}s"; }

kubectl -n monitoring rollout status deploy/metrics-gateway --timeout="$(tmo 150 120)" >/dev/null 2>&1 || true
kubectl -n security wait --for=condition=complete job/ca-publisher --timeout="$(tmo 150 120)" >/dev/null 2>&1 || true
kubectl -n monitoring rollout status deploy/prometheus --timeout="$(tmo 150 120)" >/dev/null 2>&1 || true

# the world before the rotation: samples do arrive
while [ "$(elapsed)" -lt 170 ]; do
  age=$(kubectl -n monitoring exec deploy/metrics-gateway -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/status",timeout=3)); print(d["last_write_age_s"] if d["last_write_age_s"] is not None else -1)' 2>/dev/null | tr -d '\r')
  [ "${age:--1}" -ge 0 ] && break
  sleep 3
done

kubectl -n security annotate configmap observability-ca ca/current="2" ca/previous="1" ca/next- ca/rotated-at="$(date -u +%FT%TZ)" --overwrite >/dev/null
kubectl -n monitoring set env deploy/metrics-gateway CA_ACTIVE=2 >/dev/null
kubectl -n monitoring rollout status deploy/metrics-gateway --timeout="$(tmo 225 60)" >/dev/null 2>&1 || true

# wait until the symptom is real: no writes for 45 s (a fresh gateway has none at all) and TLS errors counted
age=""; errs=""
while [ "$(elapsed)" -lt 225 ]; do
  st=$(kubectl -n monitoring exec deploy/metrics-gateway -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/status",timeout=3)); print(d["last_write_age_s"] if d["last_write_age_s"] is not None else 9999, d["tls_handshake_errors"])' 2>/dev/null | tr -d '\r')
  age=${st%% *}; errs=${st##* }
  if [ "${age:-0}" -ge 45 ] && [ "${errs:-0}" -ge 1 ]; then echo "break: done (last write ${age}s ago, TLS handshake errors: $errs)"; exit 0; fi
  sleep 4
done
echo "break: FAILED (age=${age:-?}, tls errors=${errs:-?})" >&2
exit 1
