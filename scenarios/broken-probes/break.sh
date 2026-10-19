#!/bin/sh
# SECRET. "Release 2.4.0": the app moves its health endpoint, the probes in the Deployment stay on the old path.
set -u
# short waits bounded by the clock: the runtime has already waited for the Deployment, and the whole script has to stay
# well under the break timeout (240 s)
kubectl rollout status deploy/web --timeout=90s >/dev/null 2>&1 || true
kubectl set env deploy/web APP_VERSION=2.4.0 HEALTH_PATH=/healthz >/dev/null
kubectl annotate deploy/web kubernetes.io/change-cause="pipeline: release 2.4.0" --overwrite >/dev/null
# wait until the rollout is visibly stuck: a new pod exists and is not ready, endpoints dropped below 3
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  notready=$(kubectl get pods -l app=web -o jsonpath='{range .items[*]}{.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null | grep -c false)
  eps=$(kubectl get endpoints web -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null | wc -w)
  if [ "$notready" -ge 1 ] && [ "$eps" -lt 3 ]; then echo "break: done (not-ready pods: $notready, endpoints: $eps)"; exit 0; fi
  sleep 2
done
echo "break: FAILED, rollout did not get stuck (endpoints: ${eps:-?})" >&2
exit 1
