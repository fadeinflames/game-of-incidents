#!/bin/sh
# SECRET. Two changes, a day apart in the legend:
#   1. PLAT-1182: four PriorityClasses, "medium" is the global default. Monitoring already got "critical";
#      the production ingesters have no class yet, and the pods that were running before keep priority 0.
#   2. A dedicated contour for a new customer (namespace metrics-vega, two ingesters, no class -> medium) lands on a
#      full node. The scheduler evicts production ingesters for it; their replacements are born "medium", evict the
#      last priority-0 ingester and then cannot push anybody: two of three stay Pending, the write quorum is gone.
# Preparation first: an ingester must ask for a quarter of the node, and a kind node reports the CPUs of the host it
# runs on, so the request is scaled to the real node before anything is broken.
# Time: about 15 s on the dev host. Every wait is cut to what is left of a 220 s budget (the platform gives the script 240 s).
set -u
START=$(date +%s)
fail() { echo "break: FAILED, $*" >&2; exit 1; }
t() {  # $1: seconds wanted -> a kubectl timeout that does not run over the budget
  r=$(( START + 220 - $(date +%s) ))
  [ "$r" -gt "$1" ] && r=$1
  [ "$r" -lt 1 ] && r=1
  echo "${r}s"
}
push() {
  kubectl create --raw "/api/v1/namespaces/metrics/services/gateway:http/proxy/api/v1/push" --request-timeout=5s -f - >/dev/null 2>&1 <<EOF
{"series":"wom_break","token":"wom-break-$1"}
EOF
}

# 0. the stand is up
kubectl -n metrics rollout status statefulset/ingester --timeout="$(t 60)" >/dev/null 2>&1 || fail "the ingesters did not start"
kubectl -n metrics rollout status deploy/gateway --timeout="$(t 30)" >/dev/null 2>&1 || fail "the gateway did not start"
kubectl -n metrics rollout status deploy/agents --timeout="$(t 20)" >/dev/null 2>&1 || fail "the agents did not start"
kubectl -n monitoring rollout status deploy/alerting --timeout="$(t 20)" >/dev/null 2>&1 || fail "alerting did not start"

# 1. preparation: three ingesters fill the worker node, a fourth one does not fit
alloc=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o jsonpath='{.items[0].status.allocatable.cpu}' 2>/dev/null)
case "$alloc" in
  ''|*[!0-9m]*) fail "cannot read the allocatable CPU of the worker node: '$alloc'" ;;
  *m) A=${alloc%m} ;;
  *)  A=$(( alloc * 1000 )) ;;
esac
R=$(( A / 4 / 10 * 10 ))
[ "$R" -ge 100 ] || fail "the worker node is too small: allocatable cpu $alloc"
cur=$(kubectl -n metrics get statefulset ingester -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' 2>/dev/null)
if [ "$cur" != "${R}m" ]; then
  kubectl -n metrics patch statefulset ingester --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/resources/requests/cpu\",\"value\":\"${R}m\"}]" >/dev/null || fail "cannot resize the ingesters"
  kubectl -n metrics delete pod -l app=ingester --wait=true --timeout="$(t 30)" >/dev/null 2>&1
  kubectl -n metrics rollout status statefulset/ingester --timeout="$(t 45)" >/dev/null 2>&1 || fail "three ingesters with a cpu request of ${R}m do not fit the node (allocatable $alloc)"
fi
# the ring is whole and the write path works before anything is broken
i=0; written=false
while [ "$i" -lt 15 ]; do
  if push "pre-$i"; then written=true; break; fi
  i=$(( i + 1 )); sleep 1
done
$written || fail "the write path does not work on the unbroken stand"

# 2. PLAT-1182 (yesterday in the legend): priority classes, "medium" is the default for every pod without a class
kubectl apply -f - >/dev/null <<'EOF' || fail "cannot create the priority classes"
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: critical
  labels: { change: PLAT-1182 }
value: 100000
description: "Monitoring and alerting: must keep running whatever else happens. PLAT-1182."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high
  labels: { change: PLAT-1182 }
value: 10000
description: "Stateful services on the data path: ingesters, stores. PLAT-1182."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: medium
  labels: { change: PLAT-1182 }
value: 1000
globalDefault: true
description: "Default: every pod without an explicit class. PLAT-1182."
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: low
  labels: { change: PLAT-1182 }
value: 100
description: "Batch jobs and everything else that can wait. PLAT-1182."
EOF
# monitoring was moved to its class together with the change (Recreate: no surge pod on a full node)
kubectl -n monitoring patch deploy alerting --type=merge -p '{"spec":{"template":{"spec":{"priorityClassName":"critical"}}}}' >/dev/null || fail "cannot patch alerting"
kubectl -n monitoring rollout status deploy/alerting --timeout="$(t 30)" >/dev/null 2>&1 || fail "alerting did not come back with its priority class"

# 3. the new customer's dedicated contour (this morning in the legend): the same ingester template, no priority class
kubectl apply -f - >/dev/null <<EOF || fail "cannot create the dedicated contour"
apiVersion: v1
kind: Namespace
metadata:
  name: metrics-vega
  labels: { contour: dedicated, customer: vega }
  annotations:
    platform/ticket: "ONB-311"
    platform/note: "Dedicated contour for the customer Vega. Go-live next week, not connected to a gateway yet."
---
apiVersion: v1
kind: Service
metadata:
  name: ingester
  namespace: metrics-vega
spec:
  clusterIP: None
  selector: { app: ingester }
  ports:
    - { name: http, port: 9095, targetPort: http }
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ingester
  namespace: metrics-vega
  labels: { app: ingester }
spec:
  serviceName: ingester
  replicas: 2
  podManagementPolicy: Parallel
  selector:
    matchLabels: { app: ingester }
  template:
    metadata:
      labels: { app: ingester }
    spec:
      terminationGracePeriodSeconds: 10
      containers:
        - name: ingester
          image: wom-scenario/give-way:dev
          imagePullPolicy: IfNotPresent
          env:
            - { name: ROLE, value: ingester }
            - name: POD_IP
              valueFrom: { fieldRef: { fieldPath: status.podIP } }
          ports:
            - { containerPort: 9095, name: http }
          readinessProbe:
            httpGet: { path: /ready, port: http }
            periodSeconds: 2
          resources:
            requests: { cpu: ${R}m, memory: 48Mi }
            limits: { memory: 96Mi }
EOF

# 4. the breakage is visible: every original ingester is gone, at most one replacement runs, the others are Pending,
#    the dedicated contour is up, writes are refused
deadline=$(( $(date +%s) + 75 ))
[ "$deadline" -gt $(( START + 225 )) ] && deadline=$(( START + 225 ))
state="?"
while [ "$(date +%s)" -lt "$deadline" ]; do
  pods=$(kubectl -n metrics get pods -l app=ingester -o json 2>/dev/null)
  state=$(printf '%s' "$pods" | jq -r '
    [.items[] | select(.metadata.deletionTimestamp == null)] as $p
    | "ready=\([$p[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] | length) pending=\([$p[] | select(.status.phase == "Pending" and (.spec.nodeName // "") == "")] | length) originals=\([$p[] | select((.spec.priority // 0) == 0)] | length) total=\($p | length)"' 2>/dev/null)
  tenant=$(kubectl -n metrics-vega get statefulset ingester -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  preempted=$(kubectl -n metrics get events --field-selector reason=Preempted -o name 2>/dev/null | wc -l)
  if [ "$state" = "ready=1 pending=2 originals=0 total=3" ] && [ "${tenant:-0}" = "2" ] && [ "$preempted" -ge 3 ]; then
    if ! push "post"; then
      echo "break: done (ingester cpu request ${R}m of $alloc; production: $state; dedicated contour ready: $tenant; Preempted events: $preempted)"
      exit 0
    fi
  fi
  sleep 2
done
fail "the cascade did not end as expected (production: $state; dedicated contour ready: ${tenant:-0}; Preempted events: ${preempted:-0})"
