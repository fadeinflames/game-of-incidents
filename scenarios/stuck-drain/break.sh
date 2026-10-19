#!/bin/sh
# SECRET. The planned kernel update: drain the zone-b database node. app-backend pods move, database-1 is protected by
# an over-strict PDB (minAvailable 3 of 3), the drain hangs and leaves the node cordoned. Its zonal disk lives in zone b,
# and the only other zone-b node is the spare one that is not in the db pool.
# Worst-case budget (the platform allows 240 s): 90 + 45 + 45 s of waiting.
set -u
kubectl -n production rollout status statefulset/database --timeout=90s >/dev/null 2>&1 || true
kubectl -n production rollout status deploy/app-backend --timeout=45s >/dev/null 2>&1 || true

node=$(kubectl get nodes -l topology.kubernetes.io/zone=ru-central1-b,node-pool=db -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
[ -n "$node" ] || { echo "break: FAILED, no zone-b db node" >&2; exit 1; }
kubectl label node "$node" maintenance=kernel-update --overwrite >/dev/null
kubectl annotate node "$node" wom/maintenance="kernel 6.8.0-45 security update, ticket INFRA-2291" --overwrite >/dev/null

# the drain itself, as the on-call would run it; it times out on database-1
kubectl drain "$node" --ignore-daemonsets --delete-emptydir-data --timeout=45s >/dev/null 2>&1 || true

cordoned=$(kubectl get node "$node" -o jsonpath='{.spec.unschedulable}' 2>/dev/null)
left=$(kubectl -n production get pods -l app=database --field-selector=spec.nodeName="$node" -o name 2>/dev/null | wc -l)
if [ "$cordoned" = "true" ] && [ "$left" -ge 1 ]; then echo "break: done ($node cordoned, database pods still on it: $left)"; exit 0; fi
echo "break: FAILED (cordoned=$cordoned, database pods left=$left)" >&2
exit 1
