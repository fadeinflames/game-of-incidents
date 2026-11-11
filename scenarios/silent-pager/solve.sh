#!/bin/sh
# SECRET reference solution.
#  1. Stop the loop: give the cluster DNS the memory it had before the rightsizing (within the 256Mi allowed).
#  2. Remove the amplification: the aggregator stops walking the search list for names that are already complete
#     (ndots:2) and loses the search domain nobody answers for, together with the timeout that was hiding it.
set -eu
kubectl -n kube-system set resources deploy/coredns -c coredns --limits=memory=170Mi --requests=cpu=100m,memory=70Mi >/dev/null
kubectl -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null
kubectl -n store patch deploy aggregator --type=json -p '[
  {"op": "replace", "path": "/spec/template/spec/dnsConfig", "value": {"options": [{"name": "ndots", "value": "2"}]}}]' >/dev/null
kubectl -n store rollout status deploy/aggregator --timeout=120s >/dev/null

# the grader wants 90 s without restarts and a minute of served shoppers: wait for both
set +e
deadline=$(( $(date +%s) + 200 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  age=$(kubectl -n kube-system get pods -l k8s-app=kube-dns -o json 2>/dev/null | jq -r --argjson now "$(date +%s)" '
    [.items[] | select(.metadata.deletionTimestamp == null) | (.status.containerStatuses // [])[] | if .state.running.startedAt then ($now - (.state.running.startedAt | fromdateiso8601)) else -1 end] | min // -1' 2>/dev/null)
  st=$(kubectl -n store exec deploy/shoppers -- curl -q -s -m 4 http://127.0.0.1:9090/stats </dev/null 2>/dev/null || true)
  served=$(printf '%s' "$st" | jq -r '.shoppers_60s.served // 0' 2>/dev/null || echo 0)
  gave=$(printf '%s' "$st" | jq -r '.shoppers_60s.gave_up // 0' 2>/dev/null || echo 0)
  hb=$(kubectl -n outside exec deploy/pager -- curl -q -s -m 4 http://127.0.0.1:8080/stats </dev/null 2>/dev/null | jq -r '.last_heartbeat_age_sec // -1' 2>/dev/null || echo -1)
  if [ "${age:--1}" -ge 95 ] && [ "${served:-0}" -ge 40 ] && [ "${gave:-1}" = "0" ] && [ "${hb:--1}" -ge 0 ] && [ "${hb:--1}" -le 30 ]; then
    echo "solve: done (cluster DNS up for $age s, $served shoppers served in the last minute)"
    exit 0
  fi
  sleep 5
done
echo "solve: the stand did not recover in time (dns age ${age:-?} s, served ${served:-?}, gave up ${gave:-?})" >&2
exit 1
