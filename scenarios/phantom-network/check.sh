#!/bin/sh
# SECRET grader. Result, not method: fast answers to card orders, no stuck transactions, no hung upstream calls,
# order-service stable, probes still there, the outside world (acquirers) and our own images untouched.
# Traps (bigger pool, no liveness, more proxies, switching the "external" acquirer back to normal) do not pass.
ok_fast=false;   msg_fast="POST /orders через edge отвечает дольше 5 с или 5xx/таймаут"
ok_idle=false;   msg_idle="в PostgreSQL есть сессии idle in transaction старше 10 с"
ok_hung=false;   msg_hung="в payment-proxy остаются висящие вызовы к эквайеру А"
ok_stable=false; msg_stable="order-service не стабилен (не все реплики Ready)"
ok_probe=false;  msg_probe="liveness-проба у order-service удалена или ослаблена (удалять и ослаблять пробы нельзя)"
ok_comp=false;   msg_comp="эквайеры или образы/команды сервисов изменены: эквайеры внешние, их не трогают"

IMG=wom-scenario/phantom-network:dev

# 1. orders answer fast (201 via fallback, or an honest 503 kill-switch); retry a few times while rollouts settle
i=0; probe=""
while [ $i -lt 3 ]; do
  probe=$(kubectl exec deploy/load-generator -- python3 /app/loadgen.py --probe 3 6 2>/dev/null || true)
  echo "$probe" | grep -q PROBE_OK && break
  i=$((i + 1)); sleep 5
done
codes=$(echo "$probe" | grep -oE -- '-> [0-9]+ in [0-9.]+s' | cut -c4- | tr '\n' ';' | cut -c1-120)
if echo "$probe" | grep -q PROBE_OK; then
  ok_fast=true; msg_fast="3 заказа подряд ответили ≤ 5 с ($codes)"
else
  hint=""
  echo "$codes" | grep -qE '(^|;)502 ' && hint=" (502 значит неудавшуюся оплату: нужен успех 201 через резервный эквайер или осознанный отказ 503, не ошибка)"
  msg_fast="POST /orders через edge: ${codes:-нет ответа}$hint"
fi

# 2. no idle-in-transaction sessions older than 10 s
idle=$(kubectl exec deploy/postgres -- psql -X -U orders -d orders -tAc "select count(*) from pg_stat_activity where datname='orders' and state='idle in transaction' and now()-state_change > interval '10 seconds'" 2>/dev/null | tr -dc '0-9')
[ "${idle:-1}" = "0" ] && { ok_idle=true; msg_idle="зависших транзакций нет"; } || msg_idle="в PostgreSQL ${idle:-?} сессий idle in transaction старше 10 с"

# 3. no STUCK upstream calls (> 10 s) in payment-proxy (sum over pods); short in-flight attempts to A are normal.
# Read through the API server's pod proxy (nothing runs inside the player's pod); exec is only a fallback.
# Only live pods: a Terminating replica still drains its hung calls and must not count. An unreadable counter is a failure.
stuck_of() {
  m=$(kubectl get --raw "/api/v1/namespaces/default/pods/$1:8081/proxy/metrics" 2>/dev/null)
  [ -n "$m" ] || m=$(kubectl exec "$1" -- wget -qO- http://127.0.0.1:8081/metrics 2>/dev/null)
  printf '%s\n' "$m" | grep -F 'upstream_stuck{acquirer="a"}' | awk '{print $NF}' | tr -dc '0-9'
}
hung=0; unreadable=0
pods=$(kubectl get pods -l app=payment-proxy -o json 2>/dev/null | jq -r '.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running") | .metadata.name')
[ -n "$pods" ] || unreadable=1
for p in $pods; do
  n=""; k=0
  while [ $k -lt 3 ] && [ -z "$n" ]; do
    n=$(stuck_of "$p"); k=$((k + 1))
    [ -z "$n" ] && [ $k -lt 3 ] && sleep 2
  done
  if [ -z "$n" ]; then unreadable=1; else hung=$((hung + n)); fi
done
if [ "$unreadable" -eq 1 ]; then msg_hung="не удалось прочитать метрики payment-proxy (нет работающих подов или они не отвечают)"
elif [ "$hung" -eq 0 ]; then ok_hung=true; msg_hung="висящих вызовов к эквайеру А нет"
else msg_hung="в payment-proxy висят $hung вызовов к эквайеру А"; fi

# 4. order-service stable
ready=$(kubectl get deploy order-service -o jsonpath='{.status.readyReplicas}' 2>/dev/null); want=$(kubectl get deploy order-service -o jsonpath='{.spec.replicas}' 2>/dev/null)
if [ -n "$ready" ] && [ "$ready" = "$want" ] && kubectl rollout status deploy/order-service --timeout=5s >/dev/null 2>&1; then ok_stable=true; msg_stable="order-service: $ready/$want Ready, rollout завершён"; fi

# 5. liveness probe still there and not neutered (trap): reference is httpGet, period 5 s x 3 failures, initial delay 10 s
lp=$(kubectl get deploy order-service -o json 2>/dev/null | jq -r '.spec.template.spec.containers[0].livenessProbe // empty | [.httpGet.path // "-", .periodSeconds // 10, .failureThreshold // 3, .initialDelaySeconds // 0] | map(tostring) | join(" ")')
set -- $lp
if [ "${1:--}" != "-" ] && [ "$(( ${2:-10} * ${3:-3} ))" -le 30 ] && [ "${4:-0}" -le 30 ]; then
  ok_probe=true; msg_probe="liveness-проба на месте ($1, рестарт после $(( $2 * $3 )) с неответа)"
fi

# 6. the outside world and our images are untouched: acquirers keep their behaviour (A still silent, B fine) and wiring,
# the in-house services still run the original image and command (no fake exporter, no swapped loadgen)
comp=$(kubectl get deploy -o json 2>/dev/null | jq -r '.items[] | select(.metadata.name as $n | ["acquirer-a","acquirer-b","payment-proxy","order-service","load-generator"] | index($n)) | [.metadata.name, (if (.metadata.name | startswith("acquirer")) then (.spec.replicas | tostring) else "*" end), .spec.template.spec.containers[0].image, (.spec.template.spec.containers[0].command | join(" "))] | join(" ")' | sort | tr '\n' ';')
want_comp="acquirer-a 1 $IMG python3 /app/acquirer.py;acquirer-b 1 $IMG python3 /app/acquirer.py;load-generator * $IMG python3 /app/loadgen.py;order-service * $IMG python3 /app/order_service.py;payment-proxy * $IMG python3 /app/payment_proxy.py;"
# generation 1 = the untouched stand (baseline), 2 = after the incident started: A must still be degraded, B normal
profiles=$(kubectl get configmap acquirer-sim -o json 2>/dev/null | jq -r '"\(.data.generation) \(.data.aProfile) \(.data.bProfile)"')
src_of() { kubectl get deploy "$1" -o json 2>/dev/null | jq -r '.spec.template.spec.containers[0].env[]? | select(.name == "UPSTREAM_PROFILE") | "\(.valueFrom.configMapKeyRef.name)/\(.valueFrom.configMapKeyRef.key)"'; }
if [ "$comp" = "$want_comp" ] && { [ "$profiles" = "1 normal normal" ] || [ "$profiles" = "2 degraded normal" ]; } && [ "$(src_of acquirer-a)" = "acquirer-sim/aProfile" ] && [ "$(src_of acquirer-b)" = "acquirer-sim/bProfile" ]; then
  ok_comp=true; msg_comp="эквайеры не тронуты, образы и команды сервисов исходные"
fi

passed=false
if $ok_fast && $ok_idle && $ok_hung && $ok_stable && $ok_probe && $ok_comp; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"orders-fast","ok":%s,"message":"%s"},' "$ok_fast" "$msg_fast"
printf '{"id":"no-idle-in-transaction","ok":%s,"message":"%s"},' "$ok_idle" "$msg_idle"
printf '{"id":"no-hung-upstream","ok":%s,"message":"%s"},' "$ok_hung" "$msg_hung"
printf '{"id":"order-service-stable","ok":%s,"message":"%s"},' "$ok_stable" "$msg_stable"
printf '{"id":"liveness-present","ok":%s,"message":"%s"},' "$ok_probe" "$msg_probe"
printf '{"id":"components-intact","ok":%s,"message":"%s"}' "$ok_comp" "$msg_comp"
printf ']}\n'
