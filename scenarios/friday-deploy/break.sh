#!/bin/sh
# SECRET. Friday 17:30: release v2.1.3 ("large file uploads") ships with an upload cache that never evicts.
# Under customer traffic every pod leaks past its 96Mi limit in about a minute -> OOMKilled -> CrashLoopBackOff.
# Worst-case budget (the platform allows 240 s): 30 + 30 + 45 + 100 s of waiting.
set -u
kubectl rollout status deploy/api-backend --timeout=30s >/dev/null 2>&1 || true
kubectl rollout status deploy/traffic --timeout=30s >/dev/null 2>&1 || true

kubectl set env deploy/api-backend APP_VERSION=2.1.3 UPLOAD_CACHE=on >/dev/null
kubectl annotate deploy/api-backend kubernetes.io/change-cause="release v2.1.3 (large file uploads)" --overwrite >/dev/null
kubectl rollout status deploy/api-backend --timeout=45s >/dev/null 2>&1 || true

# wait until the symptom is real: at least one pod OOMKilled
i=0
while [ $i -lt 50 ]; do
  oom=$(kubectl get pods -l app=api-backend -o jsonpath='{range .items[*]}{.status.containerStatuses[0].lastState.terminated.reason}{"\n"}{end}' 2>/dev/null | grep -c OOMKilled)
  if [ "$oom" -ge 1 ]; then echo "break: done (OOMKilled pods: $oom)"; exit 0; fi
  i=$((i + 1)); sleep 2
done
echo "break: FAILED, no OOMKilled pod after 100 seconds" >&2
exit 1
