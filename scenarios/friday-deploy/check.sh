#!/bin/sh
# SECRET grader: the leak is gone (rolled back or switched off), three healthy replicas, customers get answers,
# nobody "fixed" it with a bigger limit. After a repair the pods and the 60 s traffic window need a while to settle,
# so a Deployment without the leak gets up to ~80 s of retries.

probe() {
  ok_ver=false;   msg_ver="в Deployment всё ещё включён upload cache v2.1.3: утечка осталась, поды снова упадут"
  ok_roll=false;  msg_roll="rollout api-backend не завершён"
  ok_ready=false; msg_ready="не все 3 реплики api-backend Ready"
  ok_oom=false;   msg_oom="есть поды api-backend, упавшие с OOMKilled за последние 2 минуты: подожди, пока окно очистится, и проверь снова"
  ok_rate=false;  msg_rate="клиенты всё ещё получают ошибки (success rate за минуту ниже 95 %)"
  ok_lim=false;   msg_lim="memory limit поднят: утечка от этого не исчезает, только откладывается"

  ver=$(kubectl get deploy api-backend -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="APP_VERSION")].value}' 2>/dev/null)
  cache=$(kubectl get deploy api-backend -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="UPLOAD_CACHE")].value}' 2>/dev/null)
  if [ "$cache" != "on" ]; then
    ok_ver=true
    if [ "$ver" = "2.1.3" ]; then msg_ver="утечки нет: upload cache выключен (версия 2.1.3 осталась, откат надёжнее)"
    else msg_ver="работает версия ${ver:-без APP_VERSION} без upload cache"; fi
  fi

  if kubectl rollout status deploy/api-backend --timeout=8s >/dev/null 2>&1; then ok_roll=true; msg_roll="rollout завершён"; fi
  ready=$(kubectl get deploy api-backend -o jsonpath='{.status.readyReplicas}' 2>/dev/null); replicas=$(kubectl get deploy api-backend -o jsonpath='{.spec.replicas}' 2>/dev/null)
  [ "${ready:-0}" -ge 3 ] && [ "${ready:-0}" = "${replicas:-0}" ] && { ok_ready=true; msg_ready="$ready из $replicas реплик Ready"; }

  now=$(date +%s)
  recent=0
  for t in $(kubectl get pods -l app=api-backend -o jsonpath='{range .items[*]}{.status.containerStatuses[0].lastState.terminated.reason}{"@"}{.status.containerStatuses[0].lastState.terminated.finishedAt}{"\n"}{end}' 2>/dev/null | grep '^OOMKilled@' | cut -d@ -f2); do
    ts=$(date -d "$t" +%s 2>/dev/null || echo 0)
    [ $((now - ts)) -lt 120 ] && recent=$((recent + 1))
  done
  [ "$recent" -eq 0 ] && { ok_oom=true; msg_oom="OOMKilled за последние 2 минуты нет"; }

  rate=$(kubectl exec deploy/traffic -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); print(d["success_rate"] if d["success_rate"] is not None else -1)' 2>/dev/null | tr -d '\r')
  permille=$(printf '%s' "${rate:--1}" | awk '{printf "%d", $1*1000+0.5}')
  if [ "$permille" -ge 950 ]; then ok_rate=true; msg_rate="success rate клиентов за минуту: $((permille / 10)) %"
  elif [ "$permille" -lt 0 ]; then msg_rate="окно метрик клиентов за последнюю минуту пока пустое: подожди и проверь снова"
  else
    msg_rate="success rate клиентов за минуту $((permille / 10)) % (< 95 %)"
    $ok_ver && msg_rate="$msg_rate: окно в 60 с обновляется не сразу, подожди и проверь снова"
  fi

  lim=$(kubectl get deploy api-backend -o jsonpath='{.spec.template.spec.containers[0].resources.limits.memory}' 2>/dev/null)
  case "$lim" in 96Mi|96M|100663296) ok_lim=true; msg_lim="memory limit не тронут ($lim)";; esac
}

deadline=$(( $(date +%s) + 80 ))
while :; do
  probe
  if $ok_ver && $ok_roll && $ok_ready && $ok_oom && $ok_rate && $ok_lim; then break; fi
  # with the leak still on (or the limit raised) waiting changes nothing
  { $ok_ver && $ok_lim; } || break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 5
done

passed=false
if $ok_ver && $ok_roll && $ok_ready && $ok_oom && $ok_rate && $ok_lim; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"leaking-release-gone","ok":%s,"message":"%s"},' "$ok_ver" "$msg_ver"
printf '{"id":"rollout-complete","ok":%s,"message":"%s"},' "$ok_roll" "$msg_roll"
printf '{"id":"replicas-ready","ok":%s,"message":"%s"},' "$ok_ready" "$msg_ready"
printf '{"id":"no-recent-oom","ok":%s,"message":"%s"},' "$ok_oom" "$msg_oom"
printf '{"id":"customers-served","ok":%s,"message":"%s"},' "$ok_rate" "$msg_rate"
printf '{"id":"limit-untouched","ok":%s,"message":"%s"}' "$ok_lim" "$msg_lim"
printf ']}\n'
