#!/bin/sh
# SECRET. The 2.0.0 pipeline: (1) migration job renames total_cents -> amount_cents in one step (add, copy, DROP),
# (2) the app rollout to 2.0.0 fails to start (BILLING_CURRENCY missing from the release), (3) the CD tool rolls the
# Deployment back to 1.9.4. Code is back, the schema is not: 1.9.4 reads a column that no longer exists.
set -u
kubectl rollout status statefulset/postgres --timeout=180s >/dev/null 2>&1 || true
kubectl rollout status deploy/billing-api --timeout=120s >/dev/null 2>&1 || true
# a control row the grader looks for: recreating the database pod (an emptyDir) would lose it
kubectl exec postgres-0 -- psql -X -U billing -d billing -v ON_ERROR_STOP=1 -c "INSERT INTO invoices (customer, total_cents) VALUES ('incident-marker', 1)" >/dev/null || { echo "break: FAILED, could not write the control row" >&2; exit 1; }

cat <<'EOF' | kubectl apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate-2-0-0
  namespace: default
  labels: { app: billing-migrations, release: "2.0.0" }
spec:
  backoffLimit: 0
  template:
    metadata:
      labels: { app: billing-migrations }
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: postgres:16-alpine
          imagePullPolicy: IfNotPresent
          env:
            - { name: PGHOST, value: postgres }
            - { name: PGUSER, value: billing }
            - { name: PGDATABASE, value: billing }
            - name: PGPASSWORD
              valueFrom: { secretKeyRef: { name: postgres-secret, key: password } }
          command: ["sh", "-c"]
          args:
            - |
              set -e
              echo "== 0007_rename_total_to_amount.sql"
              psql -v ON_ERROR_STOP=1 -c "ALTER TABLE invoices ADD COLUMN amount_cents bigint;" \
                   -c "UPDATE invoices SET amount_cents = total_cents;" \
                   -c "ALTER TABLE invoices ALTER COLUMN amount_cents SET NOT NULL;" \
                   -c "ALTER TABLE invoices DROP COLUMN total_cents;"
              echo "migration applied"
EOF
kubectl wait --for=condition=complete job/migrate-2-0-0 --timeout=120s >/dev/null 2>&1 || true

# 2. the app rollout: 2.0.0 without BILLING_CURRENCY crashes on start, the rollout sticks on the first new pod
kubectl set env deploy/billing-api APP_VERSION=2.0.0 >/dev/null
kubectl annotate deploy/billing-api kubernetes.io/change-cause="release 2.0.0 (multi-currency)" --overwrite >/dev/null
i=0
while [ $i -lt 30 ]; do
  crashed=$(kubectl get pods -l app=billing-api -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' 2>/dev/null | awk '$1>=1' | wc -l)
  [ "$crashed" -ge 1 ] && break
  i=$((i + 1)); sleep 2
done

# 3. "argocd: sync failed, rolling back"
kubectl rollout undo deploy/billing-api >/dev/null
kubectl annotate deploy/billing-api kubernetes.io/change-cause="argocd: rollback to 1.9.4 after failed sync" --overwrite >/dev/null
kubectl rollout status deploy/billing-api --timeout=120s >/dev/null 2>&1 || true

# wait until the symptom is real: pods Ready (health does not touch the DB) but /invoices answers 500
i=0
while [ $i -lt 30 ]; do
  code=$(kubectl exec deploy/traffic -- python3 -c 'import urllib.request as u, urllib.error as e
try: print(u.urlopen("http://billing-api/invoices", timeout=4).status)
except e.HTTPError as x: print(x.code)
except Exception: print(0)' 2>/dev/null | tr -d '\r')
  ready=$(kubectl get deploy billing-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  if [ "${code:-0}" = "500" ] && [ "${ready:-0}" = "2" ]; then echo "break: done (billing-api 2/2 Ready, GET /invoices -> 500)"; exit 0; fi
  i=$((i + 1)); sleep 3
done
echo "break: FAILED (code=${code:-?}, ready=${ready:-?})" >&2
exit 1
