#!/bin/sh
# SECRET grader: 2.4.0 fully rolled out with working probes. Result, not method.
ok_ver=false;  msg_ver="в Deployment не версия 2.4.0 (откат не принимается)"
ok_roll=false; msg_roll="rollout web не завершён"
ok_ready=false; msg_ready="не все 3 реплики Ready"
ok_eps=false;  msg_eps="у Service web меньше 3 endpoint'ов"
ok_probe=false; msg_probe="в Deployment нет readiness- или liveness-пробы (удалять пробы нельзя)"

ver=$(kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="APP_VERSION")].value}' 2>/dev/null)
[ "$ver" = "2.4.0" ] && { ok_ver=true; msg_ver="версия 2.4.0 на месте"; }
if kubectl rollout status deploy/web --timeout=8s >/dev/null 2>&1; then ok_roll=true; msg_roll="rollout завершён"; fi
ready=$(kubectl get deploy web -o jsonpath='{.status.readyReplicas}' 2>/dev/null); updated=$(kubectl get deploy web -o jsonpath='{.status.updatedReplicas}' 2>/dev/null)
[ "${ready:-0}" = "3" ] && [ "${updated:-0}" = "3" ] && { ok_ready=true; msg_ready="3 из 3 реплик Ready и обновлены"; }
eps=$(kubectl get endpoints web -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null | wc -w)
[ "$eps" -eq 3 ] && { ok_eps=true; msg_eps="у Service web 3 endpoint'а"; }

# Both probes must be HTTP checks of the app's health endpoint: "/" answers 200 in every version and a tcpSocket/exec
# probe does not ask the app about its health at all, so such probes go green without checking anything.
hp=$(kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="HEALTH_PATH")].value}' 2>/dev/null)
hp=${hp:-/health}  # the app's default when the variable is removed
probe() {  # $1: readinessProbe | livenessProbe; sets kind (none | other | http) and path
  kind=none; path=""
  [ -n "$(kubectl get deploy web -o jsonpath="{.spec.template.spec.containers[0].$1}" 2>/dev/null)" ] || return 0
  kind=other
  [ -n "$(kubectl get deploy web -o jsonpath="{.spec.template.spec.containers[0].$1.httpGet}" 2>/dev/null)" ] || return 0
  kind=http
  path=$(kubectl get deploy web -o jsonpath="{.spec.template.spec.containers[0].$1.httpGet.path}" 2>/dev/null)
}
probe readinessProbe; rk=$kind; rp=$path
probe livenessProbe;  lk=$kind; lp=$path
if [ "$rk" != none ] && [ "$lk" != none ]; then
  if [ "$rk" != http ] || [ "$lk" != http ]; then
    msg_probe="пробы есть, но не HTTP (httpGet): по условию обе должны проверять эндпоинт здоровья приложения"
  elif [ "$hp" = "/" ] || [ "$rp" != "$hp" ] || [ "$lp" != "$hp" ]; then
    msg_probe="пробы ходят не на эндпоинт здоровья приложения (readiness: $rp, liveness: $lp)"
  else
    ok_probe=true; msg_probe="обе пробы проверяют эндпоинт здоровья приложения ($hp)"
  fi
fi

passed=false
if $ok_ver && $ok_roll && $ok_ready && $ok_eps && $ok_probe; then passed=true; fi
# jq escapes the messages: they carry values the player controls, and a quote in them must not break the JSON
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit version-2.4.0 "$ok_ver" "$msg_ver")" \
  "$(crit rollout-complete "$ok_roll" "$msg_roll")" \
  "$(crit replicas-ready "$ok_ready" "$msg_ready")" \
  "$(crit endpoints-3 "$ok_eps" "$msg_eps")" \
  "$(crit probes-present "$ok_probe" "$msg_probe")"
