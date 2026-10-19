#!/bin/sh
# SECRET. Acquirer A goes silent (accepts TCP, never answers). Then wait until the cascade is visible:
# order-service workers stuck -> edge 504 / probe of the edge slower than 5 s.
# Time budget: the waits share one deadline, the whole script stays well under the 240 s break limit.
set -u
t0=$(date +%s)
left() { r=$(( $1 - ($(date +%s) - t0) )); [ "$r" -lt 5 ] && r=5; echo "$r"; }
kubectl wait --for=condition=Available deployment --all --timeout="$(left 70)s" >/dev/null 2>&1 || true
kubectl patch configmap acquirer-sim --type=merge -p '{"data":{"generation":"2","aProfile":"degraded"}}' >/dev/null
kubectl rollout restart deploy/acquirer-a >/dev/null
kubectl rollout status deploy/acquirer-a --timeout="$(left 90)s" >/dev/null 2>&1 || true
out=""
while [ $(( $(date +%s) - t0 )) -lt 170 ]; do
  out=$(kubectl exec deploy/load-generator -- python3 /app/loadgen.py --probe 2 12 2>/dev/null || true)
  if echo "$out" | grep -q "PROBE_FAIL"; then
    # make sure it is really the hang (504/0) and not a transient
    if echo "$out" | grep -qE -- "-> (504|0) in"; then
      echo "break: done ($(echo "$out" | grep -c 'in ') probes, cascade visible)"
      exit 0
    fi
  fi
  sleep 3
done
echo "break: FAILED, cascade did not develop: $out" >&2
exit 1
