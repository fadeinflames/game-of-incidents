#!/bin/sh
# SECRET reference solution: roll the plan back at its source. The controller keeps every plan it applied in
# capacity-plan-history; revision 41 is the last one generated from current sizing data (8..12 pods).
# Then wait: the pool grows back within one controller cycle, the queue drains in about a minute,
# and the last minute of the statistics needs one more minute to forget the late jobs.
set -eu
prev=$(kubectl -n platform get configmap capacity-plan-history -o json | jq -r '.data["rev-0041"] // empty')
[ -n "$prev" ] || { echo "solve: revision 41 is not in capacity-plan-history" >&2; exit 1; }
kubectl -n platform patch configmap capacity-plan --type=merge -p "$(jq -n --arg p "$prev" '{data: {"plan.conf": $p}}')" >/dev/null

set +e
deadline=$(( $(date +%s) + 220 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  q=$(kubectl -n runs exec deploy/queue -- python3 /app/app.py stats </dev/null 2>/dev/null)
  state=$(printf '%s' "$q" | jq -r '
    if .waiting <= 15 and .oldest_wait_sec <= 3 and .last_60s.failed_to_start == 0 and .last_60s.started_late == 0
       and .last_60s.started >= 320 then "ok" else "waiting \(.waiting), late \(.last_60s.started_late), failed \(.last_60s.failed_to_start)" end' 2>/dev/null)
  ready=$(kubectl -n runs get deploy dispatcher -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  if [ "$state" = "ok" ] && [ "${ready:-0}" -ge 8 ]; then
    echo "solve: done ($ready dispatchers, the queue is empty, the last minute is clean)"
    exit 0
  fi
  sleep 5
done
echo "solve: the stand did not recover in time (${state:-no stats}, dispatchers ${ready:-?})" >&2
exit 1
