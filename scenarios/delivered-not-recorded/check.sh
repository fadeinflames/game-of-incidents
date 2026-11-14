#!/bin/sh
# SECRET grader. Result, not method:
#   - new deliveries get into the history: the grader publishes three events and looks for their deliveries through
#     history-api, the way a customer would;
#   - the history has a record for every delivery the customers received (delivery id + sha256 of the body), the
#     ones from the bad window included;
#   - every 2xx record of the history is a delivery the customers really received (same id, same hash): rows typed
#     in by hand do not pass;
#   - no customer received any delivery more than once ("send everything again" does not pass);
#   - the pipeline is left settled: no Deployment of it is in the middle of a rollout (looked at only when new
#     deliveries are recorded, so that the message does not point at the cause on the first check);
#   - the constraints of the brief hold (customers and emitter untouched, the pipeline runs its own code).
# The customers' side is the stand-in `customers`: its audit listing needs a token whose hash only is in the image.
# Side effect: three deliveries to a hook named hk-check-<token>; they are ordinary deliveries and get recorded.
NS=hooks
IMG=wom-scenario/delivered-not-recorded:dev
AUDIT_TOKEN=wom-audit-5d1f0c7a93e24b68  # secret-scan: allow (a stand fixture: the audit token of the customers stub)
TAB=$(printf '\t')
LC_ALL=C; export LC_ALL
tmp=$(mktemp -d /tmp/wom-check.XXXXXX) || exit 1
trap 'rm -rf "$tmp"' EXIT

ok_new=false;     msg_new="не удалось проверить, попадают ли новые доставки в историю"
ok_full=false;    msg_full="не удалось сверить историю с тем, что получили клиенты"
ok_genuine=false; msg_genuine="не удалось сверить записи истории с тем, что получили клиенты"
ok_once=false;    msg_once="не удалось узнать у клиентов, сколько раз они получили каждую доставку"
ok_settled=false; msg_settled="проверяется после того, как новые доставки начнут попадать в историю"
ok_rules=false;   msg_rules="не удалось проверить ограничения из брифа"

cust() { kubectl -n outside exec deploy/customers -c customers -- curl -q -s -m 8 "$@" </dev/null 2>/dev/null; }
audit() {  # $1: file. A complete listing ends with the line "#end".
  cust -H "X-Audit-Token: $AUDIT_TOKEN" http://127.0.0.1:8080/audit >"$1.raw" || return 1
  [ "$(tail -n 1 "$1.raw")" = "#end" ] || return 1
  grep -v '^#' "$1.raw" >"$1"
  return 0
}

# ---- constraints: what the API says
rules=""
kubectl get namespace hooks outside >/dev/null 2>&1 || rules="API кластера не отвечает или нет namespace hooks и outside: проверить стенд не удалось"
[ -z "$rules" ] && v=$(kubectl -n outside get deploy customers -o json 2>/dev/null | jq -r --arg img "$IMG" '
  (.spec.template.spec.containers // []) as $c
  | if ($c | length) != 1 or $c[0].image != $img or ($c[0].command // []) != ["python3", "/opt/stand/customers.py"] or $c[0].args != null
       or (($c[0].env // []) | length) != 0 or ((.spec.template.spec.volumes // []) | length) != 0 then "spec"
    elif (.status.readyReplicas // 0) != 1 or .spec.replicas != 1 then "down"
    else "ok" end' 2>/dev/null)
if [ -z "$rules" ]; then
  case "$v" in
    ok) ;;
    down) rules="customers не работает: это серверы клиентов, останавливать их нельзя" ;;
    *)    rules="customers изменён: это серверы клиентов, менять их нельзя" ;;
  esac
fi
if [ -z "$rules" ]; then
  # the customers' pod is the one the stand started with: it remembers every delivery since the beginning
  ns_born=$(kubectl get namespace outside -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null)
  v=$(kubectl -n outside get pods -l app=customers -o json 2>/dev/null | jq -r --arg born "$ns_born" '
    [.items[] | select(.metadata.deletionTimestamp == null)] as $p
    | if ($p | length) != 1 then "many"
      elif (($p[0].status.containerStatuses // []) | map(.restartCount) | add // 0) != 0 then "restarted"
      elif (($p[0].metadata.creationTimestamp | fromdateiso8601) - ($born | fromdateiso8601)) > 120 then "recreated"
      else "ok" end' 2>/dev/null)
  [ "$v" = "ok" ] || rules="под customers перезапущен или пересоздан: серверы клиентов трогать нельзя, вместе с ним пропало то, с чем сверяется история"
fi
if [ -z "$rules" ]; then
  v=$(kubectl -n "$NS" get deploy emitter -o json 2>/dev/null | jq -r --arg img "$IMG" '
    (.spec.template.spec.containers // []) as $c
    | if ($c | length) != 1 or $c[0].image != $img or ($c[0].command // []) != ["python3", "/opt/stand/emitter.py"] or $c[0].args != null
         or (($c[0].env // []) | map({key: .name, value: .value}) | from_entries) != {"REDIS_HOST": "redis", "EVENTS_PER_SEC": "2"} then "spec"
      elif (.status.readyReplicas // 0) != 1 or .spec.replicas != 1 then "down"
      else "ok" end' 2>/dev/null)
  case "$v" in
    ok) ;;
    down) rules="emitter остановлен или размножен: поток событий продукта менять нельзя" ;;
    *)    rules="emitter изменён: поток событий продукта менять нельзя" ;;
  esac
fi
if [ -z "$rules" ]; then
  v=$(kubectl -n "$NS" get deploy dispatcher recorder history-api -o json 2>/dev/null | jq -r --arg img "$IMG" '
    [.items[] | . as $d | (.spec.template.spec.containers // []) as $c
      | ({"dispatcher": "dispatcher.py", "recorder": "recorder.py", "history-api": "history_api.py"}[$d.metadata.name]) as $prog
      | select(($c | length) != 1 or $c[0].image != $img or $c[0].args != null or (($c[0].command // []) | length) != 2
               or $c[0].command[0] != "python3"
               or (($c[0].command[1] // "") | test("^/opt/pipeline/releases/(1\\.8\\.3|2\\.0\\.0)/" + $prog + "$") | not)
               or (($c[0].volumeMounts // []) | length) != 0)
      | $d.metadata.name] as $bad
    | if (.items | length) != 3 then "missing" elif ($bad | length) > 0 then ($bad | join(", ")) else "ok" end' 2>/dev/null)
  case "$v" in
    ok) ;;
    missing|"") rules="в namespace hooks нет части Deployment'ов конвейера (dispatcher, recorder, history-api)" ;;
    *) rules="компоненты конвейера должны работать из своего образа, код одного из его релизов: $v" ;;
  esac
fi

if [ -z "$rules" ]; then
  v=$(kubectl -n "$NS" get limitrange tenant-limits -o json 2>/dev/null | jq -r '
    if ((.spec.limits // []) | length) == 1 and .spec.limits[0].type == "Container" and .spec.limits[0].max.memory == "192Mi" then "ok" else "changed" end' 2>/dev/null)
  [ "$v" = "ok" ] || rules="LimitRange tenant-limits изменён или удалён: потолок памяти задаёт платформенная команда"
  others=$(kubectl -n "$NS" get limitrange -o name 2>/dev/null | wc -l | tr -dc '0-9')
  [ "${others:-0}" = "1" ] || rules="LimitRange в namespace hooks изменён: потолок памяти задаёт платформенная команда"
fi

# ---- new deliveries: three events through the whole pipeline, then the history as the customer sees it
token="$(date +%s)x$$"
hook="hk-check-$token"
sent=0; i=1
while [ "$i" -le 3 ]; do
  id=$(kubectl -n "$NS" exec deploy/redis -c redis -- redis-cli XADD events '*' hook "$hook" event check.ping payload "{\"check\":\"$token\",\"n\":$i}" </dev/null 2>/dev/null | tr -d '\r')
  case "$id" in *-*) sent=$((sent + 1)) ;; esac
  i=$((i + 1))
done
found=0; i=0
if [ "$sent" -eq 3 ]; then
  while [ "$i" -lt 6 ]; do
    sleep 2
    found=$(cust "http://history-api.hooks.svc.cluster.local:8080/hooks/$hook/deliveries?limit=5" | jq -r '[.deliveries[]? | select(.status == 200)] | length' 2>/dev/null)
    found=${found:-0}
    [ "$found" -ge 3 ] && break
    i=$((i + 1))
  done
fi

# ---- what the customers received (A), the store a few seconds later (S), the customers again (B):
#      A must be inside S (nothing is missing), S must be inside B (nothing is made up)
have_a=false; have_b=false; have_s=false
audit "$tmp/a" && have_a=true
sleep 4
if kubectl -n "$NS" exec deploy/postgres -c postgres -- psql -X -U hooks -d hooks -tA -F "$TAB" \
     -c "select delivery_id, payload_sha256, case when status between 200 and 299 then 1 else 0 end from deliveries" </dev/null >"$tmp/s.raw" 2>/dev/null; then
  have_s=true
fi
audit "$tmp/b" && have_b=true

if $have_a && $have_b; then
  cut -f1,2 "$tmp/a" | sort -u >"$tmp/a.keys"
  cut -f1,2 "$tmp/b" | sort -u >"$tmp/b.keys"
  total=$(wc -l <"$tmp/b.keys" | tr -dc '0-9')
  total_a=$(wc -l <"$tmp/a.keys" | tr -dc '0-9')
  probes=$(awk -F "$TAB" -v h="$hook" '$4 == h' "$tmp/b" | wc -l | tr -dc '0-9')
  repeated=$(awk -F "$TAB" '$3 > 1 || $5 != 0' "$tmp/b" | wc -l | tr -dc '0-9')
  if [ "$repeated" -eq 0 ]; then ok_once=true; msg_once="ни одна из $total доставок не пришла клиентам повторно"
  else msg_once="клиенты получили повторно $repeated доставок из $total: то, что уже отправлено, назад не вернуть"; fi

  if [ "$sent" -ne 3 ]; then msg_new="не удалось опубликовать проверочные события в поток events"
  elif [ "$found" -ge 3 ]; then ok_new=true; msg_new="три проверочные доставки дошли до клиента и появились в истории"
  elif [ "$probes" -lt 3 ]; then msg_new="проверочные события опубликованы, но до клиента за 12 с дошло $probes из 3"
  else msg_new="три проверочные доставки дошли до клиента, а в истории через 12 с есть только $found из 3"; fi

  if $have_s; then
    cut -f1,2 "$tmp/s.raw" | sort -u >"$tmp/s.keys"
    awk -F "$TAB" '$3 == 1 { print $1 "\t" $2 }' "$tmp/s.raw" | sort -u >"$tmp/s.ok.keys"
    rows=$(wc -l <"$tmp/s.keys" | tr -dc '0-9')
    missing=$(comm -23 "$tmp/a.keys" "$tmp/s.keys" | wc -l | tr -dc '0-9')
    unknown=$(comm -23 "$tmp/s.ok.keys" "$tmp/b.keys" | wc -l | tr -dc '0-9')
    if [ "$missing" -eq 0 ] && [ "$total_a" -gt 0 ]; then ok_full=true; msg_full="в истории есть запись о каждой из $total_a доставок, которые получили клиенты"
    else msg_full="клиенты получили $total_a доставок, в истории нет записей о $missing из них (сверяются идентификатор доставки и хэш тела)"; fi
    if [ "$unknown" -eq 0 ] && [ "$rows" -gt 0 ]; then ok_genuine=true; msg_genuine="каждой записи истории соответствует доставка, которую клиенты действительно получили"
    elif [ "$rows" -eq 0 ]; then msg_genuine="история пуста"
    else msg_genuine="в истории $unknown записей, которым не соответствует ни одна полученная клиентами доставка (сверяются идентификатор и хэш тела)"; fi
  else
    msg_full="хранилище истории доставок не отвечает"; msg_genuine=$msg_full
  fi

  # the product keeps publishing: something that is not a probe arrived between the two listings
  if [ -z "$rules" ]; then
    fresh=$(comm -13 "$tmp/a.keys" "$tmp/b.keys" | wc -l | tr -dc '0-9')
    [ "$fresh" -ge 1 ] || rules="за 4 секунды клиенты не получили ни одной новой доставки: события продукта должны доставляться и во время работ"
  fi
else
  msg_once="серверы клиентов (customers) не отвечают: сверять историю не с чем"
  msg_new=$msg_once; msg_full=$msg_once; msg_genuine=$msg_once
fi
if [ -z "$rules" ]; then ok_rules=true; msg_rules="ограничения из брифа соблюдены"; else msg_rules=$rules; fi

# ---- the pipeline is settled: what runs is what the Deployments describe, nothing is waiting to be rolled out
if $ok_new; then
  v=$(kubectl -n "$NS" get deploy dispatcher recorder history-api -o json 2>/dev/null | jq -r '
    [.items[] | select((.spec.paused // false)
                       or (.spec.replicas // 0) < 1
                       or (.status.observedGeneration // 0) < .metadata.generation
                       or (.status.updatedReplicas // 0) != .spec.replicas
                       or (.status.replicas // 0) != .spec.replicas
                       or (.status.readyReplicas // 0) != .spec.replicas) | .metadata.name] as $bad
    | if (.items | length) != 3 then "?" elif ($bad | length) > 0 then ($bad | join(", ")) else "ok" end' 2>/dev/null)
  case "$v" in
    ok) ok_settled=true; msg_settled="у Deployment'ов конвейера нет незавершённых выкаток" ;;
    "?"|"") msg_settled="не удалось прочитать состояние Deployment'ов конвейера" ;;
    *) msg_settled="работает не то, что описано в Deployment: незавершённая выкатка у $v. Когда она продолжится, поведение конвейера снова изменится" ;;
  esac
fi

passed=false
if $ok_new && $ok_full && $ok_genuine && $ok_once && $ok_settled && $ok_rules; then passed=true; fi
# jq escapes the messages: they carry values the player controls
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit new-deliveries-recorded "$ok_new" "$msg_new")" \
  "$(crit history-complete "$ok_full" "$msg_full")" \
  "$(crit history-genuine "$ok_genuine" "$msg_genuine")" \
  "$(crit no-repeated-deliveries "$ok_once" "$msg_once")" \
  "$(crit pipeline-settled "$ok_settled" "$msg_settled")" \
  "$(crit constraints "$ok_rules" "$msg_rules")"
