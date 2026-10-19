#!/bin/sh
# SECRET grader: the flood is off at the source, pods are stable, the wreckage is cleaned up, customers are served.
ok_dbg=false;   msg_dbg="debug payload всё ещё включён (DEBUG_PAYLOAD=on в ConfigMap, в Deployment или в работающих подах)"
ok_vol=false;   msg_vol="лимит тома logs изменён: sizeLimit должен остаться 64Mi"
ok_ready=false; msg_ready="recommendation-api не в 3 из 3 Ready"
ok_evict=false; msg_evict="за последние 2 минуты снова были выселения (Evicted) подов recommendation-api"
ok_clean=false; msg_clean="выселенные (Evicted) поды не убраны: kubectl get pods замусорен"
ok_rate=false;  msg_rate="клиенты всё ещё получают ошибки (success rate за минуту ниже 95 %)"
ok_ship=false;  msg_ship="log-shipper не догоняет: backlog больше 8 MiB"

# what new pods will get: a literal env value in the Deployment wins over the ConfigMap reference, so both ways of
# switching the flood off count; what running pods have right now is checked separately
cm=$(kubectl get configmap recommendation-config -o jsonpath='{.data.DEBUG_PAYLOAD}' 2>/dev/null)
tpl=$(kubectl get deploy recommendation-api -o json 2>/dev/null | jq -r '[.spec.template.spec.containers[] | select(.name == "api") | .env[]? | select(.name == "DEBUG_PAYLOAD")] | if length == 0 then "off" elif .[0].value != null then .[0].value else "cm" end' 2>/dev/null)
[ "$tpl" = "cm" ] && tpl="$cm"
still_on=0
for p in $(kubectl get pods -l app=recommendation-api -o json 2>/dev/null | jq -r '.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running") | .metadata.name' 2>/dev/null); do
  [ "$(kubectl exec "$p" -c api -- sh -c 'echo "$DEBUG_PAYLOAD"' 2>/dev/null | tr -d '\r')" = "on" ] && still_on=$((still_on + 1))
done
if [ -n "$tpl" ] && [ "$tpl" != "on" ] && [ "$still_on" -eq 0 ]; then ok_dbg=true; msg_dbg="debug payload выключен"; fi

# the guard of the node stays: a bigger volume only postpones the next eviction
lim=$(kubectl get deploy recommendation-api -o jsonpath='{.spec.template.spec.volumes[?(@.name=="logs")].emptyDir.sizeLimit}' 2>/dev/null)
[ "$lim" = "64Mi" ] && { ok_vol=true; msg_vol="лимит тома logs на месте: 64Mi"; }

ready=$(kubectl get deploy recommendation-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${ready:-0}" = "3" ] && { ok_ready=true; msg_ready="recommendation-api: 3 из 3 Ready"; }

# eviction events outlive the evicted pods (and the cleanup), unlike the pods' startTime; an empty answer is not a pass
recent=$(kubectl get events -o json 2>/dev/null | jq -r '[.items[] | select(.reason == "Evicted" and (.involvedObject.name | startswith("recommendation-api-"))) | ([.lastTimestamp, .eventTime, .metadata.creationTimestamp] | map(select(. != null) | sub("\\.[0-9]+"; "") | fromdateiso8601) | max)] | map(select(. > now - 120)) | length' 2>/dev/null)
[ "${recent:-x}" = "0" ] && { ok_evict=true; msg_evict="новых выселений за 2 минуты нет"; }

left=$(kubectl get pods -l app=recommendation-api -o jsonpath='{range .items[?(@.status.reason=="Evicted")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -c .)
[ "$left" -eq 0 ] && { ok_clean=true; msg_clean="выселенных подов не осталось"; }

rate=$(kubectl exec deploy/traffic -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); print(d["success_rate"] if d["success_rate"] is not None else -1)' 2>/dev/null | tr -d '\r')
pct=$(printf '%s' "${rate:--1}" | awk '{printf "%d", $1*100}')
[ "$pct" -ge 95 ] && { ok_rate=true; msg_rate="success rate клиентов за минуту: $pct %"; }

backlog=$(kubectl exec deploy/recommendation-api -c log-shipper -- python3 -c 'import urllib.request; print([l for l in urllib.request.urlopen("http://127.0.0.1:9102/metrics",timeout=3).read().decode().splitlines() if l.startswith("shipper_backlog_bytes")][0].split()[1])' 2>/dev/null | tr -d '\r')
[ "${backlog:-99999999}" -lt 8388608 ] && { ok_ship=true; msg_ship="log-shipper догнал: backlog $((backlog / 1024)) KiB"; }

passed=false
if $ok_dbg && $ok_vol && $ok_ready && $ok_evict && $ok_clean && $ok_rate && $ok_ship; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"debug-off","ok":%s,"message":"%s"},' "$ok_dbg" "$msg_dbg"
printf '{"id":"volume-limit-intact","ok":%s,"message":"%s"},' "$ok_vol" "$msg_vol"
printf '{"id":"replicas-ready","ok":%s,"message":"%s"},' "$ok_ready" "$msg_ready"
printf '{"id":"no-recent-evictions","ok":%s,"message":"%s"},' "$ok_evict" "$msg_evict"
printf '{"id":"evicted-cleaned","ok":%s,"message":"%s"},' "$ok_clean" "$msg_clean"
printf '{"id":"customers-served","ok":%s,"message":"%s"},' "$ok_rate" "$msg_rate"
printf '{"id":"shipper-caught-up","ok":%s,"message":"%s"}' "$ok_ship" "$msg_ship"
printf ']}\n'
