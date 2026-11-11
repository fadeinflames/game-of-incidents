#!/bin/sh
# SECRET grader. Result, not method:
#   ingesters-ready   three production ingesters are Ready, the StatefulSet has nothing left to roll, and during a
#                     20 s window none of them is replaced or restarted
#   writes-ok         a write through the gateway is acknowledged and the sample is found on at least two of the three
#                     production ingesters (asked directly, so a stub in place of the gateway does not pass)
#   production-first  the production ingesters carry an explicit priority that is strictly above the dedicated
#                     contour's and strictly above what a pod without a class gets
#   tenant-kept       the dedicated contour is still there with its two replicas (its pods may be Pending)
#   priority-rollout  PLAT-1182 is still in place: the four classes, "medium" is the default
#   sizes-kept        nobody made room by shrinking the ingesters' requests or the production replica count
# What only the player can change (classes, templates) is judged at once; what settles by itself after a correct fix
# (the StatefulSet replacing its pods, the ring filling up) gets up to 100 s. Then the 20 s window.
# Side effects: a few probe samples in the ingesters' memory (a bounded buffer).
NS=metrics
TNS=metrics-vega
JQ_CPU='def mcpu: if . == null then 0 else (tostring | if endswith("m") then (rtrimstr("m") | tonumber) else (tonumber * 1000) end) end;'

push() {  # $1: token
  kubectl create --raw "/api/v1/namespaces/$NS/services/gateway:http/proxy/api/v1/push" --request-timeout=5s -f - >/dev/null 2>&1 <<EOF
{"series":"wom_probe","token":"$1"}
EOF
}
stored() {  # $1: token -> how many of the three production ingesters hold it
  n=0
  for i in 0 1 2; do
    a=$(kubectl get --raw "/api/v1/namespaces/$NS/pods/ingester-$i:9095/proxy/has?token=$1" --request-timeout=5s 2>/dev/null | tr -d '\r\n')
    [ "$a" = "yes" ] && n=$(( n + 1 ))
  done
  echo "$n"
}
signature() {  # uid and restart count of every production ingester pod
  kubectl -n "$NS" get pods -l app=ingester -o json 2>/dev/null | jq -r '[.items[] | "\(.metadata.name)/\(.metadata.uid)/\([.status.containerStatuses[]?.restartCount] | add // 0)"] | sort | join(" ")' 2>/dev/null
}

probe() {
  ok_ready=false; msg_ready="боевые ingester'ы не в 3 из 3 Ready"
  ok_write=false; msg_write="запись через gateway не проходит"
  ok_first=false; msg_first="устойчивости нет: если места снова не хватит, боевые ingester'ы не получат его раньше остальных"
  ok_tenant=false; msg_tenant="контур «Веги» удалён или уменьшен: по условию он остаётся в кластере с двумя репликами"
  ok_classes=false; msg_classes="изменение PLAT-1182 откатано или переделано: по условию четыре класса и умолчание остаются как были"
  ok_sizes=false; msg_sizes="запросы ресурсов или число реплик ingester'ов изменены: по условию их не трогаем"
  settling=false  # true when only the cluster's own work is left

  classes=$(kubectl get priorityclass -o json 2>/dev/null)
  sts=$(kubectl -n "$NS" get statefulset ingester -o json 2>/dev/null)
  tsts=$(kubectl -n "$TNS" get statefulset ingester -o json 2>/dev/null)
  pods=$(kubectl -n "$NS" get pods -l app=ingester -o json 2>/dev/null)
  tpods=$(kubectl -n "$TNS" get pods -o json 2>/dev/null)
  nodes=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o json 2>/dev/null)
  [ -n "$classes" ] || classes='{"items":[]}'
  [ -n "$pods" ] || pods='{"items":[]}'
  [ -n "$tpods" ] || tpods='{"items":[]}'

  # --- PLAT-1182 is in place
  cls=$(printf '%s' "$classes" | jq -r '
    def v($n): ([.items[] | select(.metadata.name == $n) | .value] | first) // null;
    [.items[] | select(.globalDefault == true) | .metadata.name] as $d
    | if ([v("critical"), v("high"), v("medium"), v("low")] | any(. == null)) then "missing"
      elif ($d != ["medium"]) then "default"
      elif (v("critical") > v("high") and v("high") > v("medium") and v("medium") > v("low") and v("low") > 0) then "ok"
      else "order" end' 2>/dev/null)
  case "$cls" in
    ok)      ok_classes=true; msg_classes="изменение PLAT-1182 на месте: четыре класса, умолчание прежнее" ;;
    missing) msg_classes="не хватает классов из PLAT-1182 (critical, high, medium, low): по условию изменение не откатываем" ;;
    default) msg_classes="умолчание из PLAT-1182 изменено или снято: по условию оно остаётся как было" ;;
    order)   msg_classes="классы из PLAT-1182 пересозданы с другим порядком значений: по условию они остаются как были" ;;
  esac
  defval=$(printf '%s' "$classes" | jq -r '([.items[] | select(.globalDefault == true) | .value] | first) // 0' 2>/dev/null)
  defval=${defval:-0}

  # --- the dedicated contour is still there
  treplicas=$(printf '%s' "$tsts" | jq -r '.spec.replicas // 0' 2>/dev/null)
  if [ -n "$tsts" ] && [ "${treplicas:-0}" -ge 2 ]; then
    ok_tenant=true; msg_tenant="контур «Веги» на месте: StatefulSet ingester, реплик по спецификации: $treplicas"
  fi

  # --- sizes: a quarter of the worker node per ingester, as break.sh set it
  want=$(printf '%s' "$nodes" | jq -r "$JQ_CPU"'[.items[].status.allocatable.cpu | mcpu] | min // 0 | (. / 4 / 10 | floor) * 10' 2>/dev/null)
  pcpu=$(printf '%s' "$sts" | jq -r "$JQ_CPU"'[.spec.template.spec.containers[].resources.requests.cpu | mcpu] | add // 0' 2>/dev/null)
  tcpu=$(printf '%s' "$tsts" | jq -r "$JQ_CPU"'[.spec.template.spec.containers[].resources.requests.cpu | mcpu] | add // 0' 2>/dev/null)
  preplicas=$(printf '%s' "$sts" | jq -r '.spec.replicas // 0' 2>/dev/null)
  if [ "${want:-0}" -le 0 ]; then msg_sizes="не удалось прочитать размер рабочей ноды"
  elif [ "${preplicas:-0}" != "3" ]; then msg_sizes="у боевого StatefulSet ingester не три реплики: по условию число реплик не меняем"
  elif [ "${pcpu:-0}" -lt "$want" ]; then msg_sizes="запрос CPU боевых ingester'ов уменьшен (${pcpu}m вместо ${want}m): по условию запросы не трогаем"
  elif [ -n "$tsts" ] && [ "${tcpu:-0}" -lt "$want" ]; then msg_sizes="запрос CPU ingester'ов «Веги» уменьшен (${tcpu}m вместо ${want}m): по условию запросы не трогаем"
  else ok_sizes=true; msg_sizes="запросы ресурсов и число реплик ingester'ов прежние"; fi

  # --- production first: an explicit class in the template, above the tenant and above the default
  pclass=$(printf '%s' "$sts" | jq -r '.spec.template.spec.priorityClassName // ""' 2>/dev/null)
  pval=$(printf '%s' "$classes" | jq -r --arg n "$pclass" '([.items[] | select(.metadata.name == $n) | .value] | first) // ""' 2>/dev/null)
  # the tenant's priority: what its template asks for (or the default) and what its existing pods really carry
  tclass=$(printf '%s' "$tsts" | jq -r '.spec.template.spec.priorityClassName // ""' 2>/dev/null)
  tval=$defval
  if [ -n "$tclass" ]; then tval=$(printf '%s' "$classes" | jq -r --arg n "$tclass" '([.items[] | select(.metadata.name == $n) | .value] | first) // 0' 2>/dev/null); fi
  tpodmax=$(printf '%s' "$tpods" | jq -r '[.items[] | select(.metadata.deletionTimestamp == null) | .spec.priority // 0] | max // 0' 2>/dev/null)
  [ "${tpodmax:-0}" -gt "${tval:-0}" ] && tval=$tpodmax
  atprio=$(printf '%s' "$pods" | jq -r --arg v "${pval:-x}" '[.items[] | select(.metadata.deletionTimestamp == null) | select((.spec.priority | tostring) == $v)] | length' 2>/dev/null)
  if [ -z "$pclass" ] || [ -z "$pval" ]; then
    msg_first="устойчивости нет: если места снова не хватит, боевые ingester'ы не получат его раньше остальных, им самим ничего для этого не назначено"
  elif [ "$pval" -le "${defval:-0}" ]; then
    msg_first="устойчивости нет: боевые ingester'ы не получат место раньше подов, которым ничего отдельно не назначали"
  elif [ "$pval" -le "${tval:-0}" ]; then
    msg_first="устойчивости нет: боевые ingester'ы не получат место раньше контура «Веги»"
  elif [ "${atprio:-0}" != "3" ]; then
    settling=true
    msg_first="в шаблоне боевого StatefulSet всё назначено, но до подов это ещё не дошло: с новыми настройками работают ${atprio:-0} из 3"
  else
    ok_first=true; msg_first="боевые ingester'ы получают место раньше контура «Веги» и раньше подов без явного класса"
  fi

  # --- three production ingesters Ready, nothing left to roll
  ready=$(printf '%s' "$pods" | jq -r '[.items[] | select(.metadata.deletionTimestamp == null) | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length' 2>/dev/null)
  rolled=$(printf '%s' "$sts" | jq -r 'if (.status.updateRevision // "") == (.status.currentRevision // "-") and (.status.updatedReplicas // 0) == 3 then "yes" else "no" end' 2>/dev/null)
  if [ "${ready:-0}" != "3" ]; then msg_ready="боевые ingester'ы: Ready ${ready:-0} из 3"
  elif [ "$rolled" != "yes" ]; then msg_ready="все три боевых ingester'а Ready, но StatefulSet ещё не довёл поды до текущего шаблона"
  else ok_ready=true; msg_ready="боевые ingester'ы: Ready 3 из 3"; fi

  # --- the write path, end to end
  token="wom-$(date +%s)-$$-$1"
  if push "$token"; then
    copies=$(stored "$token")
    if [ "$copies" -ge 2 ]; then ok_write=true; msg_write="запись через gateway проходит, копии на $copies из 3 боевых ingester'ов"
    else msg_write="gateway подтвердил запись, но она нашлась только на $copies из 3 боевых ingester'ов"; fi
  fi
}

round=0
deadline=$(( $(date +%s) + 100 ))
while :; do
  round=$(( round + 1 ))
  probe "$round"
  if $ok_ready && $ok_write && $ok_first && $ok_tenant && $ok_classes && $ok_sizes; then break; fi
  # the rest is the player's move unless the template is already right and the cluster is still catching up
  if $ok_tenant && $ok_classes && $ok_sizes && { $ok_first || $settling; }; then :; else break; fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 4
done

# the window: the same three pods, no restarts, every write accepted
if $ok_ready && $ok_write && $ok_first && $ok_tenant && $ok_classes && $ok_sizes; then
  before=$(signature)
  w=0
  while [ "$w" -lt 4 ]; do
    sleep 5
    w=$(( w + 1 ))
    token="wom-$(date +%s)-$$-w$w"
    if ! push "$token" || [ "$(stored "$token")" -lt 2 ]; then
      ok_write=false; msg_write="за 20 секунд наблюдения запись через gateway перестала проходить"; break
    fi
    now=$(signature)
    if [ -z "$before" ] || [ "$now" != "$before" ]; then
      ok_ready=false; msg_ready="за 20 секунд наблюдения состав боевых подов изменился: кого-то из них пересоздали или перезапустили"; break
    fi
  done
  if $ok_ready; then msg_ready="боевые ingester'ы: Ready 3 из 3, за 20 секунд наблюдения никто не пересоздан"; fi
fi

passed=false
if $ok_ready && $ok_write && $ok_first && $ok_tenant && $ok_classes && $ok_sizes; then passed=true; fi
# jq escapes the messages: some carry values read from the cluster
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit ingesters-ready "$ok_ready" "$msg_ready")" \
  "$(crit writes-ok "$ok_write" "$msg_write")" \
  "$(crit production-first "$ok_first" "$msg_first")" \
  "$(crit tenant-kept "$ok_tenant" "$msg_tenant")" \
  "$(crit priority-rollout "$ok_classes" "$msg_classes")" \
  "$(crit sizes-kept "$ok_sizes" "$msg_sizes")"
