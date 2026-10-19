#!/bin/sh
# SECRET. Forty days of binlogs with no expiry fill the data volume; mysqld starts answering ENOSPC, blog-app's health
# fails and its liveness probe starts restarting it.
set -u
# in parallel and short: the runtime has already waited for the workloads, and the whole script has to stay well
# under the platform's break timeout (300 s)
kubectl rollout status statefulset/mysql --timeout=90s >/dev/null 2>&1 &
kubectl rollout status deploy/blog-app --timeout=90s >/dev/null 2>&1 &
wait

health_code() {
  kubectl exec deploy/blog-app -- python3 -c 'import urllib.request as u, urllib.error as e
try: print(u.urlopen("http://127.0.0.1:8080/health", timeout=3).status)
except e.HTTPError as x: print(x.code)
except Exception: print(0)' 2>/dev/null | tr -d '\r'
}
kubectl exec mysql-0 -- python3 /app/fill.py >/dev/null 2>&1 || true
# make the server notice (a write fails -> disk_full, error log lines)
kubectl exec mysql-0 -- mysql -e "INSERT INTO wp_comments VALUES (1)" >/dev/null 2>&1 || true

# fill.py also backdates the table files: the grader tells the original data directory from a re-initialized one by their age
age=$(kubectl exec mysql-0 -- sh -c 'f=/var/lib/mysql/wordpress/wp_posts.ibd; [ -f "$f" ] && echo $(( ($(date +%s) - $(stat -c %Y "$f")) / 86400 ))' 2>/dev/null | tr -d '\r')
case "$age" in ''|*[!0-9]*) age=0 ;; esac
[ "$age" -ge 30 ] || { echo "break: FAILED, the table files were not backdated (age=$age days)" >&2; exit 1; }

# wait until the symptom is real: mysql not Ready, blog-app health failing
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  mready=$(kubectl get pod mysql-0 -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)
  code=$(health_code)
  if [ "$mready" = "false" ] && [ "${code:-500}" != "200" ]; then echo "break: done (mysql ready=$mready, blog-app health=$code)"; exit 0; fi
  sleep 2
done
echo "break: FAILED (mysql ready=${mready:-?}, blog-app health=${code:-?})" >&2
exit 1
