#!/bin/sh
# SECRET grader. Result, not method:
#   - jobs of the last minute started on time and the queue is empty (asked from the queue itself);
#   - no job was thrown away: the queue was neither purged nor restarted, the clients were not touched;
#   - the capacity controller is still there, unchanged, with its permissions, and the dispatcher pods are what they were;
#   - the capacity holds: the bounds the controller really enforces (asked from the controller, not read from the
#     ConfigMap) cover the flow with the team's headroom, and for two controller cycles the pool stays at or above it.
#     To see who is in charge the grader adds one dispatcher pod by hand and waits for the controller to take it back.
#     Side effect: one extra pod for a few seconds; if nobody removes it, the grader does.
# The last check runs only when the others pass: its failing message would name the direction of the answer.
NEED=8      # 6 jobs/s, one job per second per pod, 25 % headroom
CAP=16      # the quota from the brief
IMG="wom-scenario/below-the-baseline:dev"

num() { v=$(printf '%s' "$1" | jq -r "$2 // $3" 2>/dev/null); printf '%s' "${v:-$3}"; }
qstats() { kubectl -n runs exec deploy/queue -c queue -- python3 /app/app.py stats </dev/null 2>/dev/null; }
sstats() { kubectl -n runs exec deploy/submitter -c submitter -- python3 /app/app.py stats </dev/null 2>/dev/null; }
cstatus() { kubectl -n platform exec deploy/capacity-controller -c controller -- python3 /app/app.py stats </dev/null 2>/dev/null; }
can() { kubectl auth can-i "$@" --as=system:serviceaccount:platform:capacity-controller </dev/null 2>/dev/null | head -n 1; }

ok_start=false;   msg_start="не удалось получить статистику очереди"
ok_backlog=false; msg_backlog="не удалось получить статистику очереди"
ok_lost=false;    msg_lost="не удалось проверить, что задания клиентов не потеряны"
ok_managed=false; msg_managed="не удалось проверить capacity-controller"
ok_holds=false;   msg_holds="устойчивость не проверялась: сначала задания должны стартовать вовремя, очередь разобраться, а остальные проверки пройти"

q=$(qstats)
s=$(sstats)

# ---- jobs of the last minute
if [ -n "$q" ]; then
  recv=$(num "$q" '.last_60s.received' 0); started=$(num "$q" '.last_60s.started' 0)
  late=$(num "$q" '.last_60s.started_late' 0); failed=$(num "$q" '.last_60s.failed_to_start' 0)
  ontime=$((started - late)); decided=$((started + failed))
  if [ "$recv" -lt 300 ]; then
    msg_start="за последнюю минуту в очередь пришло только $recv заданий (обычный поток около 360): клиенты не доходят до очереди или минута ещё не прошла"
  elif [ "$failed" -eq 0 ] && [ "$late" -le 3 ] && [ "$started" -ge 300 ]; then
    ok_start=true; msg_start="за последнюю минуту вовремя стартовало $ontime заданий из $decided, не стартовавших нет"
  else
    pct=0; [ "$decided" -gt 0 ] && pct=$((ontime * 100 / decided))
    msg_start="за последнюю минуту вовремя (за 5 с) стартовало $pct % заданий: $ontime из $decided, не стартовало $failed, с опозданием $late"
  fi

  # ---- the queue itself
  waiting=$(num "$q" '.waiting' 0); oldest=$(num "$q" '.oldest_wait_sec' 0)
  small=$(printf '%s' "$q" | jq -r 'if .waiting <= 30 and .oldest_wait_sec <= 5 then 1 else 0 end' 2>/dev/null)
  if [ "${small:-0}" = "1" ]; then ok_backlog=true; msg_backlog="очередь разобрана: ждёт $waiting заданий"
  else msg_backlog="в очереди ждёт $waiting заданий, самое старое ждёт $oldest с: нужно не больше 30 заданий и не дольше 5 с"; fi
fi

# ---- nothing was thrown away
ns=$(kubectl get ns runs -o json 2>/dev/null)
objs=$(kubectl -n runs get deploy,pods -o json 2>/dev/null)
v=$(printf '%s' "$objs" | jq -r --argjson ns "${ns:-null}" '
  def ts: fromdateiso8601;
  def verdict($d; $p; $t0; $name):
    ([$d[] | select(.metadata.name == $name)] | first) as $dep
    | [$p[] | select(.metadata.labels.app == $name)] as $pods
    | if $dep == null then "missing"
      elif $dep.metadata.generation != 1 or $dep.spec.replicas != 1 then "changed"
      elif (($dep.metadata.creationTimestamp | ts) - $t0) > 120 then "restarted"
      elif ($pods | length) != 1 then "restarted"
      elif (($pods[0].metadata.creationTimestamp | ts) - ($dep.metadata.creationTimestamp | ts)) > 75 then "restarted"
      elif ([$pods[0].status.containerStatuses[]?.restartCount] | add // 0) > 0 then "restarted"
      elif ([$pods[0].status.containerStatuses[]? | select(.ready)] | length) != 1 then "notready"
      else "ok" end;
  ($ns.metadata.creationTimestamp | ts) as $t0
  | [.items[] | select(.kind == "Deployment")] as $d
  | [.items[] | select(.kind == "Pod" and .metadata.deletionTimestamp == null)] as $p
  | verdict($d; $p; $t0; "queue") + " " + verdict($d; $p; $t0; "submitter")' 2>/dev/null)
v_queue=${v%% *}; v_sub=${v##* }
purged=$(num "$q" '.totals.purged' 0)
q_recv=$(num "$q" '.totals.received' -1); s_sent=$(num "$s" '.submitted_total' -1)
if [ -z "$q" ] || [ -z "$v" ]; then :
elif [ "$purged" -gt 0 ]; then
  msg_lost="из очереди удалено без запуска $purged заданий: это задания клиентов, терять их нельзя"
elif [ "$v_queue" = "notready" ] || [ "$v_sub" = "notready" ]; then
  msg_lost="queue или submitter не в Ready"
elif [ "$v_queue" != "ok" ]; then
  msg_lost="очередь перезапускали или меняли: она держит задания в памяти, и всё, что в ней ждало, потеряно"
elif [ "$v_sub" != "ok" ]; then
  msg_lost="submitter перезапускали или меняли: он изображает клиентов, трогать его нельзя"
elif [ "$s_sent" -lt 0 ] || [ "$q_recv" -lt 0 ]; then :
elif [ $((s_sent - q_recv)) -gt 30 ] || [ $((q_recv - s_sent)) -gt 30 ]; then
  msg_lost="счётчики клиентов и очереди расходятся (отправлено $s_sent, очередь помнит $q_recv): очередь или submitter перезапускали"
else
  ok_lost=true; msg_lost="задания клиентов на месте: очередь не очищали и не перезапускали"
fi

# ---- the controller is still there and still able to do its job; the dispatcher pods are what they were
cv=$(kubectl -n platform get deploy capacity-controller -o json 2>/dev/null | jq -r --arg img "$IMG" '
  (.spec.template.spec) as $s | ($s.containers // []) as $c
  | if .spec.replicas != 1 then "stopped"
    elif ($c | length) != 1 or $c[0].image != $img or $c[0].command != null or $c[0].args != null
         or (($c[0].env // []) | map({key: .name, value: .value}) | from_entries) != {"ROLE": "controller"}
         or (($s.volumes // []) | length) != 0 or (($c[0].volumeMounts // []) | length) != 0
         or (($s.initContainers // []) | length) != 0 or $s.serviceAccountName != "capacity-controller" then "changed"
    elif (.status.readyReplicas // 0) != 1 then "notready"
    else "ok" end' 2>/dev/null)
dj=$(kubectl -n runs get deploy dispatcher -o json 2>/dev/null)
dv=$(printf '%s' "$dj" | jq -r --arg img "$IMG" '
  (.spec.template.spec) as $s | ($s.containers // []) as $c
  | if ($c | length) != 1 or $c[0].image != $img or $c[0].command != null or $c[0].args != null
       or (($c[0].env // []) | map({key: .name, value: .value}) | from_entries) != {"ROLE": "dispatcher", "QUEUE_ADDR": "queue.runs.svc.cluster.local:8080"}
       or (($s.initContainers // []) | length) != 0 or $s.hostNetwork == true then "changed"
    else "ok" end' 2>/dev/null)
case "${cv:-missing}" in
  ok)
    if [ "$(can patch deployments.apps --subresource=scale -n runs)" != "yes" ] || [ "$(can get deployments.apps --subresource=scale -n runs)" != "yes" ] \
       || [ "$(can get configmaps -n platform)" != "yes" ] || [ "$(can patch configmaps -n platform)" != "yes" ]; then
      msg_managed="у capacity-controller отобраны права, без которых он не может управлять числом подов dispatcher"
    elif [ "${dv:-missing}" != "ok" ]; then
      msg_managed="Deployment dispatcher изменён или удалён (образ, команда, переменные): по условию у него меняется только число подов, и меняет его capacity-controller"
    else
      ok_managed=true; msg_managed="capacity-controller работает, его права и шаблон подов dispatcher не изменены"
    fi ;;
  stopped)  msg_managed="capacity-controller остановлен: по условию числом подов dispatcher управляет он" ;;
  changed)  msg_managed="Deployment capacity-controller изменён (образ, команда, переменные, тома или сервисный аккаунт): контроллер должен остаться прежним" ;;
  notready) msg_managed="capacity-controller не в Ready" ;;
  *)        msg_managed="capacity-controller удалён: по условию числом подов dispatcher управляет он" ;;
esac

# ---- the capacity holds, and it is the controller who holds it
if $ok_start && $ok_backlog && $ok_lost && $ok_managed; then
  c=$(cstatus)
  mn=$(num "$c" '.pools.dispatcher.min_replicas' 0); mx=$(num "$c" '.pools.dispatcher.max_replicas' 0)
  des=$(num "$c" '.pools.dispatcher.desired' 0); c0=$(num "$c" '.cycles' 0)
  rej=$(printf '%s' "$c" | jq -r '.plan_rejected // empty' 2>/dev/null)
  r0=$(printf '%s' "$dj" | jq -r '.spec.replicas // 0' 2>/dev/null); r0=${r0:-0}
  ready0=$(printf '%s' "$dj" | jq -r '.status.readyReplicas // 0' 2>/dev/null); ready0=${ready0:-0}
  if [ -z "$c" ]; then
    msg_holds="capacity-controller не отвечает на запрос состояния"
  elif [ -n "$rej" ]; then
    msg_holds="capacity-controller отклонил текущий план и работает по предыдущему: $rej"
  elif [ "$mn" -lt "$NEED" ] || [ "$mx" -lt "$mn" ] || [ "$mx" -gt "$CAP" ]; then
    msg_holds="capacity-controller держит для dispatcher границы $mn..$mx подов. Нужно: нижняя не меньше $NEED (поток 6 заданий в секунду, под запускает одно, запас 25 %), верхняя не больше $CAP (квота)"
  elif [ "$r0" != "$des" ] || [ "$ready0" != "$r0" ]; then
    msg_holds="число подов dispatcher ещё меняется (в Deployment $r0, в Ready $ready0, контроллер держит $des): подожди и проверь снова"
  else
    kubectl -n runs scale deploy dispatcher --replicas=$((des + 1)) >/dev/null 2>&1
    t0=$(date +%s); min_ready=$ready0; back=0; cyc=0; spec=$((des + 1)); took=0
    while :; do
      sleep 3
      line=$(kubectl -n runs get deploy dispatcher -o jsonpath='{.spec.replicas} {.status.readyReplicas}' 2>/dev/null)
      spec=${line%% *}; rd=${line##* }; spec=${spec:-0}; rd=${rd:-0}
      [ "$rd" -lt "$min_ready" ] && min_ready=$rd
      c1=$(num "$(cstatus)" '.cycles' 0); cyc=$((c1 - c0))
      took=$(( $(date +%s) - t0 ))
      if [ "$spec" = "$des" ] && [ "$cyc" -ge 2 ]; then back=1; break; fi
      [ "$took" -ge 42 ] && break
    done
    if [ "$back" != "1" ]; then
      kubectl -n runs scale deploy dispatcher --current-replicas=$((des + 1)) --replicas="$r0" >/dev/null 2>&1
      if [ "$spec" = "$des" ]; then msg_holds="capacity-controller за $took с не прошёл двух циклов: проверь, что он работает, и повтори проверку"
      else msg_holds="проверка добавила один под dispatcher вручную, и за $took с его никто не убрал: числом подов сейчас никто не управляет"; fi
    elif [ "$min_ready" -lt "$NEED" ]; then
      msg_holds="за время наблюдения в Ready было только $min_ready подов dispatcher, нужно не меньше $NEED всё время"
    else
      ok_holds=true; msg_holds="capacity-controller держит $des подов dispatcher (границы $mn..$mx) два цикла подряд и сам убрал под, добавленный проверкой вручную"
    fi
  fi
fi

passed=false
if $ok_start && $ok_backlog && $ok_lost && $ok_managed && $ok_holds; then passed=true; fi
# jq escapes the messages: they carry values the player controls
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit jobs-start-on-time "$ok_start" "$msg_start")" \
  "$(crit queue-drained "$ok_backlog" "$msg_backlog")" \
  "$(crit no-jobs-lost "$ok_lost" "$msg_lost")" \
  "$(crit scaling-managed "$ok_managed" "$msg_managed")" \
  "$(crit capacity-holds "$ok_holds" "$msg_holds")"
