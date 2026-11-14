#!/bin/sh
# SECRET. Release 2.0.0 of the pipeline (CHG-4521) changes how the dispatcher hands delivery records over to the
# recorder: one JSON envelope in the stream field "rec" instead of flat stream fields. The release is rolled out
# component by component and stops half-way:
#   1. history-api 2.0.0: rolls out (no functional change, a red herring);
#   2. recorder 2.0.0: rolls out (Recreate) and now reads only the new format;
#   3. dispatcher 2.0.0: the manifest raises its memory limit to 256Mi, the LimitRange of the namespace allows 192Mi,
#      the new ReplicaSet cannot create a single pod. The two old dispatchers keep working and keep writing the old
#      format. Every pod is Ready, nothing restarts, nothing logs an error.
# The recorder acknowledges the old-format entries and skips them: deliveries reach the customers, their records
# never reach the store. Time: about 40 s on the dev host; every wait is cut to a 200 s budget.
set -u
START=$(date +%s)
NS=hooks
fail() { echo "break: FAILED, $*" >&2; exit 1; }
left() { [ "$(date +%s)" -lt $(( START + 200 )) ]; }
t() {  # $1: seconds wanted -> a kubectl timeout that stays inside the budget
  r=$(( START + 200 - $(date +%s) ))
  [ "$r" -gt "$1" ] && r=$1
  [ "$r" -lt 1 ] && r=1
  echo "${r}s"
}
stored() { kubectl -n "$NS" exec deploy/postgres -- psql -X -U hooks -d hooks -tAc "select count(*) from deliveries" </dev/null 2>/dev/null | tr -dc '0-9'; }
received() { kubectl -n outside exec deploy/customers -- curl -q -s -m 4 http://127.0.0.1:8080/stats </dev/null 2>/dev/null | jq -r '.deliveries_received // 0' 2>/dev/null; }
skipped() { kubectl -n "$NS" exec deploy/recorder -- curl -q -s -m 4 http://127.0.0.1:9102/metrics </dev/null 2>/dev/null | awk '$1 == "recorder_entries_skipped_total" { print $2 }'; }

# 0. the stand is up and the pipeline records what it delivers
for d in "$NS/redis" "$NS/postgres" "$NS/dispatcher" "$NS/recorder" "$NS/history-api" "$NS/emitter" outside/customers; do
  kubectl -n "${d%/*}" rollout status "deploy/${d#*/}" --timeout="$(t 90)" >/dev/null 2>&1 || fail "deployment $d is not ready"
done
n=0; got=0
while left; do
  n=$(stored); n=${n:-0}
  got=$(received); got=${got:-0}
  [ "$n" -ge 30 ] && [ $(( got - n )) -le 6 ] && break
  sleep 2
done
[ "$n" -ge 30 ] && [ $(( got - n )) -le 6 ] || fail "the unbroken pipeline does not record deliveries (customers received $got, the store has $n)"

release() {  # $1: deployment, $2: program, $3: extra JSON patch operations
  kubectl -n "$NS" patch deploy "$1" --type=json -p "[
    {\"op\": \"replace\", \"path\": \"/metadata/annotations/kubernetes.io~1change-cause\", \"value\": \"release 2.0.0 (CHG-4521)\"},
    {\"op\": \"replace\", \"path\": \"/metadata/labels/app.kubernetes.io~1version\", \"value\": \"2.0.0\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/metadata/labels/app.kubernetes.io~1version\", \"value\": \"2.0.0\"},
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/command/1\", \"value\": \"/opt/pipeline/releases/2.0.0/$2\"}$3]" >/dev/null \
    || fail "cannot patch deployment $1"
}

# 1. history-api
release history-api history_api.py ""
kubectl -n "$NS" rollout status deploy/history-api --timeout="$(t 60)" >/dev/null 2>&1 || fail "history-api 2.0.0 did not roll out"

# 2. recorder
release recorder recorder.py ""
kubectl -n "$NS" rollout status deploy/recorder --timeout="$(t 60)" >/dev/null 2>&1 || fail "recorder 2.0.0 did not roll out"

# 3. dispatcher: the rollout that never starts
release dispatcher dispatcher.py ',
    {"op": "replace", "path": "/spec/template/spec/containers/0/resources/limits/memory", "value": "256Mi"}'
# (the ReplicaFailure condition of the Deployment comes and goes between the attempts of the ReplicaSet, so the
# check looks at what stays: nothing updated, both old pods ready, a FailedCreate event on a ReplicaSet)
stuck=""
while left; do
  stuck=$(kubectl -n "$NS" get deploy dispatcher -o json 2>/dev/null | jq -r '
    if (.status.observedGeneration // 0) >= .metadata.generation
       and (.status.updatedReplicas // 0) == 0
       and (.status.readyReplicas // 0) == 2 then "yes" else "" end' 2>/dev/null)
  if [ "$stuck" = "yes" ]; then
    refused=$(kubectl -n "$NS" get events --field-selector reason=FailedCreate,involvedObject.kind=ReplicaSet -o json 2>/dev/null \
      | jq -r '[.items[] | select((.message // "") | test("maximum memory usage per Container"))] | length' 2>/dev/null)
    [ "${refused:-0}" -ge 1 ] && break
    stuck=""
  fi
  sleep 2
done
[ "$stuck" = "yes" ] || fail "the dispatcher rollout is not stuck the way the story needs"

# 4. the breakage is visible: the recorder skips, the store falls behind the customers
s=0; n=0; got=0
while left; do
  s=$(skipped); s=${s:-0}
  n=$(stored); n=${n:-0}
  got=$(received); got=${got:-0}
  [ "$s" -ge 20 ] && [ $(( got - n )) -ge 20 ] && break
  sleep 2
done
[ "$s" -ge 20 ] && [ $(( got - n )) -ge 20 ] || fail "the gap did not develop (skipped $s, customers received $got, the store has $n)"
echo "break: done (customers received $got deliveries, the store has $n, the recorder skipped $s)"
