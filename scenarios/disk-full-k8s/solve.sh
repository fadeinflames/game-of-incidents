#!/bin/sh
# SECRET reference solution: purge old binlogs through the server (index stays consistent), set expiry at runtime
# and in the config so that it survives a restart, wait for the probes to recover.
set -eu
kubectl exec mysql-0 -- mysql -e "PURGE BINARY LOGS BEFORE NOW() - INTERVAL 1 DAY" >/dev/null
kubectl exec mysql-0 -- mysql -e "SET GLOBAL binlog_expire_logs_seconds = 259200" >/dev/null
kubectl patch configmap mysql-config --type=merge -p '{"data":{"wom.cnf":"[mysqld]\nlog_bin = binlog\nmax_binlog_size = 4M\nbinlog_expire_logs_seconds = 259200\n"}}' >/dev/null
# a write proves the server is back; then the probes catch up
kubectl exec mysql-0 -- mysql -e "INSERT INTO wp_comments VALUES (3)" >/dev/null
pods_ready() {
  mready=$(kubectl get pod mysql-0 -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null) || mready=
  bready=$(kubectl get deploy blog-app -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || bready=
  [ "$mready" = "true" ] && [ "${bready:-0}" = "1" ]
}
i=0
while [ $i -lt 15 ] && ! pods_ready; do i=$((i + 1)); sleep 3; done
# blog-app may be sitting out a CrashLoopBackOff that grew while the database was down (up to 5 min between
# restarts): a rollout restart brings a fresh pod with no backoff
if ! pods_ready; then
  kubectl rollout restart deploy/blog-app >/dev/null
  kubectl rollout status deploy/blog-app --timeout=120s >/dev/null
fi
echo "solve: done"
