#!/bin/sh
# SECRET reference solution. The order: writes back first, then the cause, then the dedicated contour returns.
set -eu

# 1. Mitigation. The dedicated contour has no traffic yet: stop it, and the Pending production ingesters get their
#    place back (still with the default priority). Writes recover in seconds.
kubectl -n metrics-vega scale statefulset ingester --replicas=0 >/dev/null
kubectl -n metrics rollout status statefulset/ingester --timeout=80s >/dev/null

# 2. The cause. The production ingesters get the class PLAT-1182 meant for them. The priority of an existing pod
#    cannot be changed, so the StatefulSet replaces its pods one at a time; two of three stay in the ring all the way.
kubectl -n metrics patch statefulset ingester --type=merge -p '{"spec":{"template":{"spec":{"priorityClassName":"high"}}}}' >/dev/null
kubectl -n metrics rollout status statefulset/ingester --timeout=120s >/dev/null

# 3. The contour comes back exactly as it was. Its pods (medium by default) cannot push the production ones (high)
#    and wait in Pending until the new nodes arrive.
kubectl -n metrics-vega scale statefulset ingester --replicas=2 >/dev/null
echo "solve: done"
