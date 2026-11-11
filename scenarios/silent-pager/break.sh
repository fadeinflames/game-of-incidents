#!/bin/sh
# SECRET. Two steps, as in the story.
#  1. "Three weeks ago": the rightsizing job cuts the memory limit of the cluster DNS to 1.5 x of its 30-day peak.
#  2. "Tonight": one downstream service of the store (recs) answers slowly for a minute. Pages fail, shoppers reload
#     them, every reload resolves every downstream name again, each lookup parks four queries in CoreDNS for six
#     seconds (ndots:5 + a search domain nobody answers for). CoreDNS runs out of its 32Mi and is OOM-killed.
# Then recs is back to normal, but the crowd of retrying shoppers kills CoreDNS again on every start.
set -u
t_end=$(( $(date +%s) + 215 ))
left() { [ "$(date +%s)" -lt "$t_end" ]; }
recs() { kubectl -n outside exec deploy/backends -- curl -q -s -m 4 -o /dev/null "http://127.0.0.1:8080/admin/slow?svc=recs&ms=$1" </dev/null 2>/dev/null; }
fail() { recs 0; echo "break: FAILED, $*" >&2; exit 1; }
shop() { kubectl -n store exec deploy/shoppers -- curl -q -s -m 4 http://127.0.0.1:9090/stats </dev/null 2>/dev/null; }

for d in infra/dc-resolver outside/backends outside/pager store/sessions store/aggregator store/shoppers monitoring/alert-relay; do
  kubectl -n "${d%/*}" rollout status "deploy/${d#*/}" --timeout=60s >/dev/null 2>&1 || fail "deployment $d is not ready"
done

# 1. the rightsizing; the new pods also start with the Corefile from the manifests for sure
kubectl -n kube-system patch deploy coredns --type=strategic -p '{
  "metadata": {"annotations": {"platform.shopnet.example/rightsizing": "PLAT-3318, weekly rightsizing of system pods: memory limit = 1.5 x peak usage over the last 30 days (21Mi) = 32Mi, request = 24Mi. Before: limit 170Mi, request 70Mi."}},
  "spec": {"template": {"spec": {"containers": [{"name": "coredns", "resources": {"limits": {"memory": "32Mi"}, "requests": {"cpu": "100m", "memory": "24Mi"}}}]}}}}' >/dev/null || fail "cannot patch coredns"
kubectl -n kube-system rollout status deploy/coredns --timeout=90s >/dev/null 2>&1 || fail "coredns did not roll out"

# the world before the incident: the store serves its shoppers, nobody retries
served=0; retrying=-1
while left; do
  s=$(shop)
  served=$(printf '%s' "$s" | jq -r '.shoppers_60s.served // 0' 2>/dev/null); served=${served:-0}
  retrying=$(printf '%s' "$s" | jq -r '.now.of_them_retrying // -1' 2>/dev/null); retrying=${retrying:--1}
  [ "$served" -ge 6 ] && [ "$retrying" = "0" ] && break
  sleep 2
done
[ "$served" -ge 6 ] && [ "$retrying" = "0" ] || fail "the store did not become healthy (served: $served, retrying: $retrying)"

# 2. the trigger: recs answers in 8 s, the aggregator gives up after 5 s
recs 8000 || fail "cannot slow recs down"

# wait until every CoreDNS pod has been OOM-killed at least twice
looped=0
while left; do
  looped=$(kubectl -n kube-system get pods -l k8s-app=kube-dns -o json 2>/dev/null | jq -r '
    [.items[] | select(.metadata.deletionTimestamp == null)] as $p
    | if ($p | length) > 0 and all($p[]; any((.status.containerStatuses // [])[]; .restartCount >= 2 and (.lastState.terminated.reason // "") == "OOMKilled")) then 1 else 0 end' 2>/dev/null)
  [ "${looped:-0}" = "1" ] && break
  sleep 3
done
[ "${looped:-0}" = "1" ] || fail "the cluster DNS did not get into the OOM loop"

# the owners of recs roll their change back; the store does not recover
recs 0 || fail "cannot restore recs"
sleep 4
retrying=$(shop | jq -r '.now.of_them_retrying // 0' 2>/dev/null)
[ "${retrying:-0}" -ge 15 ] || fail "too few retrying shoppers after the trigger: ${retrying:-?}"
echo "break: done (cluster DNS is OOM-killed in a loop, $retrying shoppers are retrying)"
