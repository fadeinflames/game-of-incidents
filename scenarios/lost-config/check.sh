#!/bin/sh
# SECRET grader: every running web-app pod uses API_TIMEOUT=30, the password comes from the Secret, rollout is complete.
ok_cm=false;   msg_cm="в ConfigMap web-app-config нет API_TIMEOUT=30"
ok_roll=false; msg_roll="rollout web-app не завершён"
ok_ready=false; msg_ready="не все 2 реплики Ready и обновлены"
ok_env=false;  msg_env="поды web-app всё ещё работают со старым таймаутом"
ok_sec=false;  msg_sec="DATABASE_PASSWORD не приходит из Secret postgres-secret (secretKeyRef)"
ok_crash=false; msg_crash="есть поды web-app в CrashLoopBackOff"

cm=$(kubectl get configmap web-app-config -o jsonpath='{.data.API_TIMEOUT}' 2>/dev/null)
[ "$cm" = "30" ] && { ok_cm=true; msg_cm="ConfigMap: API_TIMEOUT=30"; }

if kubectl rollout status deploy/web-app --timeout=8s >/dev/null 2>&1; then ok_roll=true; msg_roll="rollout завершён"; fi
ready=$(kubectl get deploy web-app -o jsonpath='{.status.readyReplicas}' 2>/dev/null); updated=$(kubectl get deploy web-app -o jsonpath='{.status.updatedReplicas}' 2>/dev/null)
[ "${ready:-0}" = "2" ] && [ "${updated:-0}" = "2" ] && { ok_ready=true; msg_ready="2 из 2 реплик Ready и обновлены"; }

# what the pods actually run with (env is fixed at pod start, so this is the real test); terminating pods are ignored
total=0; good=0; seen=""
pods=$(kubectl get pods -l app=web-app -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.deletionTimestamp}{"|"}{.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null | awk -F'|' '$2=="" && $3=="true"{print $1}')
for p in $pods; do
  total=$((total + 1))
  v=$(kubectl exec "$p" -c web-app -- sh -c 'echo "$API_TIMEOUT"' 2>/dev/null | tr -d '\r')
  seen="$seen $p=${v:-?}"
  [ "$v" = "30" ] && good=$((good + 1))
done
if [ "$total" -ge 2 ] && [ "$good" -eq "$total" ]; then ok_env=true; msg_env="все $total пода работают с API_TIMEOUT=30"; else msg_env="поды web-app всё ещё работают со старым таймаутом ($good из $total с 30:$seen)"; fi

sname=$(kubectl get deploy web-app -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DATABASE_PASSWORD")].valueFrom.secretKeyRef.name}' 2>/dev/null)
skey=$(kubectl get deploy web-app -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DATABASE_PASSWORD")].valueFrom.secretKeyRef.key}' 2>/dev/null)
literal=$(kubectl get deploy web-app -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DATABASE_PASSWORD")].value}' 2>/dev/null)
if [ "$sname" = "postgres-secret" ] && [ "$skey" = "password" ]; then ok_sec=true; msg_sec="DATABASE_PASSWORD берётся из Secret postgres-secret";
elif [ -n "$literal" ]; then msg_sec="пароль вписан текстом в манифест Deployment, а должен приходить из Secret postgres-secret"; fi

crash=$(kubectl get pods -l app=web-app -o jsonpath='{range .items[*]}{.status.containerStatuses[0].state.waiting.reason}{"\n"}{end}' 2>/dev/null | grep -c CrashLoopBackOff)
[ "$crash" -eq 0 ] && { ok_crash=true; msg_crash="падающих подов нет"; }

passed=false
if $ok_cm && $ok_roll && $ok_ready && $ok_env && $ok_sec && $ok_crash; then passed=true; fi
# jq escapes the messages: they carry values the player controls, and a quote in them must not break the JSON
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit configmap-30 "$ok_cm" "$msg_cm")" \
  "$(crit rollout-complete "$ok_roll" "$msg_roll")" \
  "$(crit replicas-ready "$ok_ready" "$msg_ready")" \
  "$(crit pods-timeout-30 "$ok_env" "$msg_env")" \
  "$(crit password-from-secret "$ok_sec" "$msg_sec")" \
  "$(crit no-crashloop "$ok_crash" "$msg_crash")"
