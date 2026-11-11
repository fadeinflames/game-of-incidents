#!/bin/sh
# SECRET grader. Result, not method:
#   1. shop/storefront is whole (3 of 3 Ready, replica count untouched);
#   2. the other applications are whole too (billing/invoicer 2 of 2, tools/status-page 1 of 1);
#   3. a brand-new bare pod is admitted in shop and in billing (the grader creates one and deletes it at once);
#   4. the cause is removed, not muted: while those pods were created the API server did not call a webhook that
#      nobody serves. Two independent views: the fail-open counter of the API server must not grow during the probe
#      (catches failurePolicy Ignore on any dead backend), and no webhook with a dead Service backend may select
#      a label-less pod of these namespaces (catches the same thing without relying on an alpha metric).
# Removing the webhook, taking both namespaces out of its selector or excluding them in the webhook all pass.
# Nothing here reads files of the player; the probe pod is bound to a node that does not exist, so it never
# starts, emits no events and is force-deleted right after the create call.

stamp="$$-$(date +%s)"
probe_name="wom-check-$stamp"
trap 'for n in shop billing; do kubectl -n "$n" delete pod "$probe_name" --grace-period=0 --force --wait=false >/dev/null 2>&1; done' EXIT

# $1 namespace, $2 deployment, $3 expected replicas. Sets got (ready) and total (pods the controller owns).
whole() {
  set -- "$1" "$2" "$3" $(kubectl -n "$1" get deploy "$2" -o json 2>/dev/null \
    | jq -r '[.spec.replicas // 0, .status.readyReplicas // 0, .status.updatedReplicas // 0, .status.replicas // 0] | join(" ")' 2>/dev/null)
  got=${5:-0}; total=${7:-0}
  [ "${4:-x}" = "$3" ] && [ "${5:-0}" = "$3" ] && [ "${6:-0}" = "$3" ] && [ "${7:-0}" = "$3" ]
}

# $1 namespace: 0 when the API server accepted a new bare pod without labels
probe_pod() {
  if kubectl -n "$1" create -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $probe_name
spec:
  nodeName: wom-check-no-such-node
  restartPolicy: Never
  terminationGracePeriodSeconds: 0
  containers:
    - name: probe
      image: wom-scenario/not-a-single-pod:dev
      imagePullPolicy: Never
      command: ["true"]
      resources:
        requests: { cpu: 1m, memory: 1Mi }
        limits: { cpu: 10m, memory: 8Mi }
EOF
  then rc=0; else rc=1; fi
  kubectl -n "$1" delete pod "$probe_name" --grace-period=0 --force --wait=false >/dev/null 2>&1
  return $rc
}

# how many times the API server has skipped a failed webhook call so far (all webhooks); fails when unreadable
fail_open() {
  kubectl get --raw /metrics 2>/dev/null \
    | awk '/^apiserver_admission_webhook_fail_open_count[{ ]/ { s += $NF } END { if (NR < 100) exit 1; printf "%d\n", s }'
}

# webhooks that intercept pod creation, have a Service backend nobody serves and select a label-less pod in shop or billing
dead_hooks() {
  {
    kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations -o json
    kubectl get services -A -o json
    kubectl get endpointslices.discovery.k8s.io -A -o json
    kubectl get namespaces shop billing -o json
  } 2>/dev/null | jq -rs '
    def sel($l): (. // {}) as $s
      | all(($s.matchLabels // {}) | to_entries[]; $l[.key] == .value)
        and all(($s.matchExpressions // [])[];
          .key as $k | (.values // []) as $v | ($l | has($k)) as $has
          | if .operator == "In" then $has and any($v[]; . == $l[$k])
            elif .operator == "NotIn" then ($has | not) or all($v[]; . != $l[$k])
            elif .operator == "Exists" then $has
            elif .operator == "DoesNotExist" then ($has | not)
            else true end);
    def pods_create: any(.rules[]?;
          any(.operations[]?; . == "CREATE" or . == "*")
      and any(.resources[]?; . == "pods" or . == "*" or . == "*/*")
      and any(.apiGroups[]?; . == "" or . == "*")
      and any(.apiVersions[]?; . == "v1" or . == "*"));
    def dead($svcs; $eps): .clientConfig.service as $r
      | if $r == null then false
        else ($r.port // 443) as $port
          | ([$svcs[] | select(.metadata.namespace == $r.namespace and .metadata.name == $r.name)] | .[0]) as $svc
          | if $svc == null then true
            elif ([$svc.spec.ports[]? | select(.port == $port)] | length) == 0 then true
            else ([$eps[]
                   | select(.metadata.namespace == $r.namespace and (.metadata.labels // {})["kubernetes.io/service-name"] == $r.name)
                   | .endpoints[]? | select(.conditions.ready != false)] | length) == 0
            end
        end;
    if length != 4 then error("incomplete input") else . end
    | .[0].items as $cfgs | .[1].items as $svcs | .[2].items as $eps | .[3].items as $nss
    | if ($nss | length) != 2 then error("namespaces missing") else . end
    | [ $cfgs[] | .metadata.name as $cfg | .webhooks[]?
        | select(pods_create and ((.matchConditions // []) | length) == 0 and dead($svcs; $eps))
        | select(. as $h
            | ($h.objectSelector | sel({}))
              and any($nss[]; (.metadata.labels // {}) as $l | ($h.namespaceSelector | sel($l))))
        | "\($cfg)/\(.name)" ]
    | unique | join(", ")'
}

# ---- admission: probe pods, with the fail-open counter read before and after
ok_new=false;   msg_new=""
ok_cause=false; msg_cause="причина не устранена: новые поды по-прежнему не создаются"
bad_ns=""
fo1=$(fail_open) || fo1=""
for ns in shop billing; do probe_pod "$ns" || bad_ns="${bad_ns:+$bad_ns, }$ns"; done
fo2=$(fail_open) || fo2=""
if [ -z "$bad_ns" ]; then
  ok_new=true; msg_new="новый под создаётся и в shop, и в billing"
  dead=$(dead_hooks); dead_rc=$?
  if [ "$dead_rc" -ne 0 ] || [ -z "$fo1" ] || [ -z "$fo2" ]; then
    msg_cause="не удалось опросить API-сервер, запусти проверку ещё раз"
  elif [ -n "$dead" ]; then
    msg_cause="поды создаются, но причина заглушена, а не убрана: при создании пода API-сервер по-прежнему вызывает вебхук, за которым никого нет ($dead)"
  elif [ "$fo2" -gt "$fo1" ]; then
    msg_cause="поды создаются, но причина заглушена, а не убрана: при создании пода API-сервер по-прежнему вызывает вебхук, который не отвечает, и молча пропускает ошибку"
  else
    ok_cause=true; msg_cause="при создании пода API-сервер не обращается к неработающим вебхукам"
  fi
else
  msg_new="новый под не создаётся в namespace: $bad_ns (проверка создаёт под и сразу его удаляет)"
fi

# ---- applications; pods that already exist get up to 30 s to become Ready, pods that do not exist are not waited for
apps() {
  ok_front=false; ok_rest=false
  whole shop storefront 3 && ok_front=true; front_got=$got; front_total=$total
  rest=true
  whole billing invoicer 2 || rest=false; inv_total=$total
  whole tools status-page 1 || rest=false
  $rest && ok_rest=true
}
deadline=$(( $(date +%s) + 30 ))
while :; do
  apps
  if $ok_front && $ok_rest; then break; fi
  $ok_new || break
  { [ "$front_total" -ge 1 ] && [ "$inv_total" -ge 1 ]; } || break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 3
done
msg_front="shop/storefront: Ready $front_got из 3 (нужны три реплики, все из текущего шаблона Deployment)"
# the API server admits pods again, but the ReplicaSet has backed off and has not retried yet: say so, the next step is the player's
if ! $ok_front && $ok_new && [ "$front_total" -eq 0 ]; then msg_front="shop/storefront: Ready 0 из 3: новые поды уже допускаются, но контроллер пока не создал ни одного"; fi
$ok_front && msg_front="shop/storefront: 3 из 3 Ready"
msg_rest="не все остальные приложения кластера в полном составе: посмотри Deployment'ы в других namespace"
$ok_rest && msg_rest="остальные приложения в полном составе"

passed=false
if $ok_front && $ok_rest && $ok_new && $ok_cause; then passed=true; fi
# jq escapes the messages: they carry names the player controls, and a quote in them must not break the JSON
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s]}\n' "$passed" \
  "$(crit storefront-ready "$ok_front" "$msg_front")" \
  "$(crit other-apps-ready "$ok_rest" "$msg_rest")" \
  "$(crit new-pod-admitted "$ok_new" "$msg_new")" \
  "$(crit cause-removed "$ok_cause" "$msg_cause")"
