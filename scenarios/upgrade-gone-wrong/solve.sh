#!/bin/sh
# SECRET reference solution: stop the bleeding first (pause auto-upgrade), then give the stateful pods their node back
# (uncordon); they rejoin with their data. The proper upgrade (a zone-a replacement node first) is planned for daytime.
set -eu
kubectl -n kube-system patch configmap node-upgrade --type=merge -p '{"data":{"autoUpgrade":"false","pausedBy":"on-call, INC-4471: replacement node landed in the wrong zone"}}' >/dev/null
for n in $(kubectl get nodes -l node-pool=stateful -o jsonpath='{range .items[?(@.spec.unschedulable==true)]}{.metadata.name}{"\n"}{end}'); do
  kubectl uncordon "$n" >/dev/null
done
kubectl -n production rollout status statefulset/events --timeout=180s >/dev/null
kubectl -n production rollout status statefulset/store --timeout=180s >/dev/null
echo "solve: done"
