#!/bin/sh
# SECRET grader: the loop is broken for real (no running pod gossips), replicas are sane and stable, customers are served.
# A frozen or deleted HPA with gossip still on only pauses the storm: it does not pass.
# The state is judged by what the pods really run with (a ConfigMap edit without a restart changes nothing, and
# `kubectl set env` replaces the ConfigMap reference with a literal). After a repair the rollout, the HPA scale-down and the
# 60 s traffic window need a while to settle, so a Deployment whose config is already fixed gets up to ~80 s of retries.

probe() {
  ok_loop=false;   msg_loop="петля не разорвана: поды всё ещё усиливают нагрузку друг на друга"
  ok_reps=false;   msg_reps="checkout-api не в 2–6 репликах (или не все Ready, или rollout не завершён)"
  ok_stable=false; msg_stable="число реплик ещё меняется"
  ok_rate=false;   msg_rate="клиенты всё ещё получают ошибки или ждут (success rate < 95 % или p95 > 1000 мс)"
  ok_pay=false;    msg_pay="payment-api не в 2 из 2 Ready"

  total=0; gossiping=0; unknown=0
  for p in $(kubectl get pods -l app=checkout-api --no-headers -o custom-columns=NAME:.metadata.name,DEL:.metadata.deletionTimestamp 2>/dev/null | awk '$2=="<none>"{print $1}'); do
    total=$((total + 1))
    v=$(kubectl exec "$p" -- sh -c 'echo "PEER_GOSSIP=$PEER_GOSSIP"' 2>/dev/null | tr -d '\r')
    case "$v" in
      PEER_GOSSIP=on) gossiping=$((gossiping + 1));;
      PEER_GOSSIP=*) ;;
      *) unknown=$((unknown + 1));;
    esac
  done
  cm=$(kubectl get configmap checkout-config -o jsonpath='{.data.PEER_GOSSIP}' 2>/dev/null)
  if [ "$total" -eq 0 ] || [ "$unknown" -gt 0 ]; then msg_loop="не удалось проверить поды checkout-api (их нет или они ещё запускаются): подожди и проверь снова"
  elif [ "$gossiping" -gt 0 ]; then
    msg_loop="в $gossiping из $total подов checkout-api всё ещё работает peer gossip: нагрузка на под растёт с числом подов, HPA снова раскачает реплики"
    [ "$cm" != "on" ] && msg_loop="$msg_loop (ConfigMap уже без gossip, но поды читают переменную окружения только при старте)"
  else ok_loop=true; msg_loop="peer gossip выключен во всех подах: нагрузка на под больше не растёт с числом подов"; fi

  spec=$(kubectl get deploy checkout-api -o jsonpath='{.spec.replicas}' 2>/dev/null)
  ready=$(kubectl get deploy checkout-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  updated=$(kubectl get deploy checkout-api -o jsonpath='{.status.updatedReplicas}' 2>/dev/null)
  present=$(kubectl get deploy checkout-api -o jsonpath='{.status.replicas}' 2>/dev/null)
  if [ "${spec:-0}" -gt 6 ]; then msg_reps="checkout-api в $spec репликах, ожидается 2–6 (если HPA ещё снимает лишние, подожди и проверь снова)"
  elif [ "${spec:-0}" -ge 2 ] && [ "${ready:-0}" = "$spec" ] && [ "${updated:-0}" = "$spec" ] && [ "${present:-0}" = "$spec" ]; then ok_reps=true; msg_reps="checkout-api: $ready из $spec Ready"; fi

  if $ok_reps; then
    sleep 15
    spec2=$(kubectl get deploy checkout-api -o jsonpath='{.spec.replicas}' 2>/dev/null)
    hpa_des=$(kubectl get hpa checkout-api -o jsonpath='{.status.desiredReplicas}' 2>/dev/null)
    hpa_cur=$(kubectl get hpa checkout-api -o jsonpath='{.status.currentReplicas}' 2>/dev/null)
    if [ "$spec2" = "$spec" ] && [ "${hpa_des:-$spec}" = "$spec" ] && [ "${hpa_cur:-$spec}" = "$spec" ]; then ok_stable=true; msg_stable="число реплик стабильно ($spec)"; fi
  fi

  stats=$(kubectl exec deploy/traffic -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); print(d["success_rate"] if d["success_rate"] is not None else -1, d["p95_ms"] if d["p95_ms"] is not None else 99999)' 2>/dev/null | tr -d '\r')
  permille=$(printf '%s' "${stats:--1 99999}" | awk '{printf "%d", $1*1000+0.5}')
  p95=$(printf '%s' "${stats:--1 99999}" | awk '{printf "%d", $2}')
  if [ "$permille" -ge 950 ] && [ "$p95" -le 1000 ]; then ok_rate=true; msg_rate="клиенты: success rate $((permille / 10)) %, p95 $p95 мс"
  elif [ "$permille" -lt 0 ]; then msg_rate="окно метрик клиентов за последнюю минуту пока пустое: подожди и проверь снова"
  else
    msg_rate="клиенты: success rate $((permille / 10)) %, p95 $p95 мс (нужно ≥ 95 % и p95 ≤ 1000 мс)"
    $ok_loop && msg_rate="$msg_rate: окно в 60 с обновляется не сразу, подожди и проверь снова"
  fi

  pready=$(kubectl get deploy payment-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${pready:-0}" = "2" ] && { ok_pay=true; msg_pay="payment-api: 2 из 2 Ready"; }
}

# is the Deployment configured without gossip (what the next pods will get)? Only then does waiting make sense.
config_fixed() {
  names=$(kubectl get deploy checkout-api -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' 2>/dev/null)
  case " $names " in *" PEER_GOSSIP "*) ;; *) return 0;; esac
  lit=$(kubectl get deploy checkout-api -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PEER_GOSSIP")].value}' 2>/dev/null)
  [ -n "$lit" ] && { [ "$lit" != "on" ]; return; }
  cmv=$(kubectl get configmap checkout-config -o jsonpath='{.data.PEER_GOSSIP}' 2>/dev/null)
  [ "$cmv" != "on" ]
}

deadline=$(( $(date +%s) + 80 ))
while :; do
  probe
  if $ok_loop && $ok_reps && $ok_stable && $ok_rate && $ok_pay; then break; fi
  config_fixed || break
  # pods that still gossip are replaced only by a rollout: with none in progress (e.g. the ConfigMap edited, pods not restarted) waiting changes nothing
  $ok_loop || [ "${present:-0}" != "${updated:-0}" ] || [ "${ready:-0}" != "${spec:-0}" ] || break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 5
done

passed=false
if $ok_loop && $ok_reps && $ok_stable && $ok_rate && $ok_pay; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"loop-broken","ok":%s,"message":"%s"},' "$ok_loop" "$msg_loop"
printf '{"id":"replicas-sane","ok":%s,"message":"%s"},' "$ok_reps" "$msg_reps"
printf '{"id":"replicas-stable","ok":%s,"message":"%s"},' "$ok_stable" "$msg_stable"
printf '{"id":"customers-served","ok":%s,"message":"%s"},' "$ok_rate" "$msg_rate"
printf '{"id":"payment-untouched","ok":%s,"message":"%s"}' "$ok_pay" "$msg_pay"
printf ']}\n'
