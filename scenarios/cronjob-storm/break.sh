#!/bin/sh
# SECRET. The data team switched the 15-minute export to "every minute, we'll tune it later" with concurrencyPolicy: Allow.
# Jobs pile up: five are already running (created here so the player does not wait 5 minutes), and the CronJob adds one
# more every minute until someone stops it.
set -u
# short waits bounded by the clock: the runtime has already waited for the Deployment, and the whole script has to stay
# well under the break timeout (240 s)
kubectl -n batch rollout status deploy/api --timeout=90s >/dev/null 2>&1 || true

kubectl -n batch patch cronjob nightly-export --type=merge -p '{"spec":{"schedule":"*/1 * * * *"}}' >/dev/null
kubectl -n batch annotate cronjob nightly-export kubernetes.io/change-cause="data-team: run export every minute (temporary)" --overwrite >/dev/null

n=2891
while [ $n -le 2895 ]; do
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-export-$n
  namespace: batch
  labels: { app: nightly-export }
  annotations: { cronjob.kubernetes.io/instantiate: manual }
spec:
  backoffLimit: 1
  template:
    metadata:
      labels: { app: nightly-export }
    spec:
      restartPolicy: Never
      containers:
        - name: export
          image: wom-scenario/cronjob-storm:dev
          imagePullPolicy: IfNotPresent
          command: ["sh", "/app/export.sh"]
          env:
            - { name: EXPORT_SECONDS, value: "900" }
            - { name: PGHOST, value: postgres.data.svc }
            - { name: S3_BUCKET, value: reports-export }
          resources:
            requests: { cpu: 50m, memory: 16Mi }
            limits: { cpu: 100m, memory: 32Mi }
EOF
  n=$((n + 1))
done

# wait until the storm is visible: at least 4 export pods running
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  running=$(kubectl -n batch get pods -l app=nightly-export --field-selector=status.phase=Running -o name 2>/dev/null | wc -l)
  if [ "$running" -ge 4 ]; then echo "break: done (running export pods: $running)"; exit 0; fi
  sleep 2
done
echo "break: FAILED, export pods did not start (running=${running:-?})" >&2
exit 1
