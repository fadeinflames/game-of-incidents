#!/bin/sh
# SECRET grader: the blog works, mysql accepts writes, the volume has room, binlog.index is consistent,
# binlog expiry is configured so that it does not happen again, and the data directory is still the original one.
ok_blog=false;  msg_blog="blog-app не отвечает 200 на /health"
ok_write=false; msg_write="mysql не принимает записи"
ok_free=false;  msg_free="на /var/lib/mysql занято больше 70 %"
ok_idx=false;   msg_idx="binlog.index ссылается на удалённые файлы: такой MySQL не переживёт рестарт (удалять бинлоги нужно через PURGE BINARY LOGS)"
ok_exp=false;   msg_exp="ротация бинлогов не настроена (binlog_expire_logs_seconds = 0): диск заполнится снова"
ok_data=false;  msg_data="данные блога потеряны: каталог /var/lib/mysql создан заново (том стенда не переживает пересоздание пода mysql-0)"
ok_pods=false;  msg_pods="mysql-0 или blog-app не Ready"

health_code() {
  kubectl exec deploy/blog-app -- python3 -c 'import urllib.request as u, urllib.error as e
try: print(u.urlopen("http://127.0.0.1:8080/health", timeout=3).status)
except e.HTTPError as x: print(x.code)
except Exception: print(0)' 2>/dev/null | tr -d '\r'
}

if kubectl exec mysql-0 -- mysql -e "INSERT INTO wp_comments VALUES (2)" >/dev/null 2>&1; then ok_write=true; msg_write="mysql принимает записи"; fi

used=$(kubectl exec mysql-0 -- df -P /var/lib/mysql 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')
[ -n "$used" ] && [ "$used" -le 70 ] && { ok_free=true; msg_free="на /var/lib/mysql занято $used %"; }

missing=$(kubectl exec mysql-0 -- sh -c 'cd /var/lib/mysql && n=0; for f in $(cat binlog.index 2>/dev/null); do [ -e "$f" ] || n=$((n+1)); done; echo $n' 2>/dev/null | tr -d '\r')
[ "${missing:-1}" = "0" ] && { ok_idx=true; msg_idx="binlog.index согласован с файлами"; }

exp=$(kubectl exec mysql-0 -- mysql -e "SHOW VARIABLES LIKE 'binlog_expire_logs_seconds'" 2>/dev/null | awk -F'|' '/binlog_expire/{gsub(/ /,"",$3); print $3}')
cmexp=$(kubectl get configmap mysql-config -o jsonpath='{.data.wom\.cnf}' 2>/dev/null | grep -Eo '(binlog_expire_logs_seconds|expire_logs_days)[[:space:]]*=[[:space:]]*[1-9][0-9]*' | head -1 | tr -d '[:space:]')
if [ "${exp:-0}" -gt 0 ] 2>/dev/null || [ -n "$cmexp" ]; then ok_exp=true; msg_exp="ротация бинлогов настроена (${cmexp:-binlog_expire_logs_seconds=$exp})"; fi

# break.sh backdated the table files by 240 days; a data directory re-initialized after the pod was deleted is brand new
age=$(kubectl exec mysql-0 -- sh -c 'f=/var/lib/mysql/wordpress/wp_posts.ibd; [ -f "$f" ] && echo $(( ($(date +%s) - $(stat -c %Y "$f")) / 86400 ))' 2>/dev/null | tr -d '\r')
case "$age" in ''|*[!0-9]*) age=0 ;; esac
[ "$age" -ge 30 ] && { ok_data=true; msg_data="данные блога на месте (каталог базы прежний)"; }

# The probes need a few periods to notice a repaired database, so once mysql itself is fine the pods get ~40 s.
# A broken database gets a single attempt: waiting would not change the answer.
tries=1
if $ok_write && $ok_free; then tries=10; fi
i=0
while [ $i -lt $tries ]; do
  [ $i -gt 0 ] && sleep 4
  i=$((i + 1))
  code=$(health_code)
  mready=$(kubectl get pod mysql-0 -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)
  bready=$(kubectl get deploy blog-app -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "$code" = "200" ] && [ "$mready" = "true" ] && [ "${bready:-0}" = "1" ] && break
done
[ "$code" = "200" ] && { ok_blog=true; msg_blog="blog-app отвечает 200"; }
[ "$mready" = "true" ] && [ "${bready:-0}" = "1" ] && { ok_pods=true; msg_pods="mysql-0 и blog-app Ready"; }
if $ok_write && $ok_free && ! $ok_blog; then
  waiting=$(kubectl get pods -l app=blog-app -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null)
  case "$waiting" in *CrashLoopBackOff*) msg_blog="база уже работает, но blog-app в CrashLoopBackOff: kubelet держит паузу до 5 минут перед следующим запуском. Подожди или перезапусти его: kubectl rollout restart deploy/blog-app";; esac
fi

passed=false
if $ok_blog && $ok_write && $ok_free && $ok_idx && $ok_exp && $ok_data && $ok_pods; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"blog-healthy","ok":%s,"message":"%s"},' "$ok_blog" "$msg_blog"
printf '{"id":"mysql-writes","ok":%s,"message":"%s"},' "$ok_write" "$msg_write"
printf '{"id":"volume-free","ok":%s,"message":"%s"},' "$ok_free" "$msg_free"
printf '{"id":"binlog-index","ok":%s,"message":"%s"},' "$ok_idx" "$msg_idx"
printf '{"id":"expiry-configured","ok":%s,"message":"%s"},' "$ok_exp" "$msg_exp"
printf '{"id":"data-preserved","ok":%s,"message":"%s"},' "$ok_data" "$msg_data"
printf '{"id":"pods-ready","ok":%s,"message":"%s"}' "$ok_pods" "$msg_pods"
printf ']}\n'
