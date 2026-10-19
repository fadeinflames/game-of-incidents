#!/bin/sh
# SECRET. Release 1.8.0 of report-api doubles its CPU request (200m -> 400m). The namespace already uses 1950m of the
# 2000m quota, so the ReplicaSet cannot create the new pod; with maxUnavailable: 1 one old pod is gone and the rollout sticks.
set -u
# in parallel and short: the runtime has already waited for the Deployments, and the whole script has to stay well
# under the platform's break timeout (300 s)
kubectl -n production rollout status deploy/report-api --timeout=90s >/dev/null 2>&1 &
kubectl -n production rollout status deploy/worker --timeout=90s >/dev/null 2>&1 &
wait

kubectl -n production patch deploy report-api --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/resources/requests/cpu","value":"400m"},
  {"op":"replace","path":"/spec/template/spec/containers/0/env/1/value","value":"1.8.0"},
  {"op":"add","path":"/metadata/annotations/kubernetes.io~1change-cause","value":"release 1.8.0 (requests.cpu 400m)"}]' >/dev/null

# wait until the symptom is real: only one report-api pod left and the ReplicaSet reports FailedCreate / exceeded quota
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  running=$(kubectl -n production get pods -l app=report-api --field-selector=status.phase=Running -o name 2>/dev/null | wc -l)
  failed=$(kubectl -n production get events --field-selector=reason=FailedCreate -o jsonpath='{range .items[*]}{.message}{"\n"}{end}' 2>/dev/null | grep -c "exceeded quota")
  if [ "$running" -le 1 ] && [ "$failed" -ge 1 ]; then echo "break: done (running report-api pods: $running, FailedCreate events: $failed)"; exit 0; fi
  sleep 2
done
echo "break: FAILED, rollout did not get stuck on the quota (running=${running:-?}, failed=${failed:-?})" >&2
exit 1
