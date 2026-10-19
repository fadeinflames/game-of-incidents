#!/bin/sh
# SECRET. The developer's "just bump the timeout" YAML: the ConfigMap gets API_TIMEOUT=30, and the whole Deployment is
# re-applied from a file that never had DATABASE_PASSWORD. Old pods keep running with 10 (env is read at pod start);
# the new pod crashes without the password, so the rollout sticks (maxUnavailable: 0 keeps the old ones alive).
set -u
# short waits bounded by the clock: the runtime has already waited for the Deployment, and the whole script has to stay
# well under the break timeout (240 s)
kubectl rollout status deploy/web-app --timeout=90s >/dev/null 2>&1 || true

kubectl patch configmap web-app-config --type=merge -p '{"data":{"API_TIMEOUT":"30"}}' >/dev/null

cat <<'EOF' | kubectl apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: default
  labels: { app: web-app }
  annotations:
    kubernetes.io/change-cause: "dev: API_TIMEOUT 30 (yaml from Slack)"
spec:
  replicas: 2
  selector:
    matchLabels: { app: web-app }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  template:
    metadata:
      labels: { app: web-app }
    spec:
      containers:
        - name: web-app
          image: wom-scenario/lost-config:dev
          imagePullPolicy: IfNotPresent
          env:
            - name: API_TIMEOUT
              valueFrom: { configMapKeyRef: { name: web-app-config, key: API_TIMEOUT } }
            - name: DATABASE_HOST
              valueFrom: { configMapKeyRef: { name: web-app-config, key: DATABASE_HOST } }
            - name: LOG_LEVEL
              valueFrom: { configMapKeyRef: { name: web-app-config, key: LOG_LEVEL } }
          ports:
            - { containerPort: 8080, name: http }
          readinessProbe:
            httpGet: { path: /health, port: http }
            periodSeconds: 3
            failureThreshold: 2
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { memory: 64Mi }
EOF

# wait until the symptom is real: two old pods ready, the new one has crashed at least once
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  ready=$(kubectl get pods -l app=web-app -o jsonpath='{range .items[*]}{.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null | grep -c true)
  crashed=$(kubectl get pods -l app=web-app -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' 2>/dev/null | awk '$1>=1' | wc -l)
  if [ "$ready" -ge 2 ] && [ "$crashed" -ge 1 ]; then echo "break: done (ready old pods: $ready, crashing new pods: $crashed)"; exit 0; fi
  sleep 2
done
echo "break: FAILED, expected 2 ready old pods and a crashing new one (ready=${ready:-?}, crashed=${crashed:-?})" >&2
exit 1
