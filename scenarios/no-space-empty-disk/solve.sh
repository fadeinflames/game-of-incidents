#!/bin/sh
# SECRET reference solution: a memory-backed emptyDir mounted at /dev/shm of the database pod (the data stays on the PVC),
# then the failed report is run again.
set -eu
kubectl patch statefulset sales-db --type=json -p='[
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"dshm","emptyDir":{"medium":"Memory","sizeLimit":"256Mi"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"dshm","mountPath":"/dev/shm"}}]' >/dev/null
kubectl rollout status statefulset/sales-db --timeout=150s >/dev/null
# the pod is Ready when PostgreSQL accepts connections; make sure of it before the report starts
i=0
until kubectl exec sales-db-0 -c postgres -- pg_isready -h 127.0.0.1 -U postgres -d sales </dev/null >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "solve: sales-db did not come back" >&2; exit 1; }
  sleep 2
done
job="revenue-report-rerun-$(date +%s)"
kubectl create job "$job" --from=cronjob/revenue-report >/dev/null
kubectl wait --for=condition=complete "job/$job" --timeout=150s >/dev/null
echo "solve: done ($job complete)"
