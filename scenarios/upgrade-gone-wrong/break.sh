#!/bin/sh
# SECRET. Wednesday 02:00, the maintenance window opens: autoUpgrade flips to true. The controller drains the zone-a
# stateful node; the PDBs let one replica of each StatefulSet go, and those replicas cannot come back: their zonal disks
# are in zone a, the replacement node the platform added is in zone d. Under-replicated events, degraded store.
# Time budget: the whole script stays well under the 240 s break limit (waits share one deadline).
set -u
t0=$(date +%s)
left() { r=$(( $1 - ($(date +%s) - t0) )); [ "$r" -lt 5 ] && r=5; echo "$r"; }
kubectl -n production rollout status statefulset/events --timeout="$(left 80)s" >/dev/null 2>&1 || true
kubectl -n production rollout status statefulset/store --timeout="$(left 80)s" >/dev/null 2>&1 || true
kubectl -n kube-system rollout status deploy/node-upgrade-controller --timeout="$(left 80)s" >/dev/null 2>&1 || true

kubectl -n kube-system patch configmap node-upgrade --type=merge -p '{"data":{"autoUpgrade":"true","startedAt":"wed 02:00 (maintenance window)"}}' >/dev/null

# wait until the cascade is real: the zone-a stateful node cordoned and at least one stateful pod Pending
cordoned=""; pending=0
while [ $(( $(date +%s) - t0 )) -lt 200 ]; do
  cordoned=$(kubectl get nodes -l node-pool=stateful,topology.kubernetes.io/zone=ru-central1-a -o jsonpath='{range .items[?(@.spec.unschedulable==true)]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1)
  pending=$(kubectl -n production get pods --field-selector=status.phase=Pending -o name 2>/dev/null | wc -l)
  if [ -n "$cordoned" ] && [ "$pending" -ge 1 ]; then echo "break: done ($cordoned cordoned, pending stateful pods: $pending)"; exit 0; fi
  sleep 3
done
echo "break: FAILED (cordoned=${cordoned:-none}, pending=${pending:-?})" >&2
exit 1
