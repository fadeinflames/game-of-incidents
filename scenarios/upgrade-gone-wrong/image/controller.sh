#!/bin/sh
# node-upgrade-controller: the managed-Kubernetes auto-upgrade, in-cluster. Every 30 s: if ConfigMap kube-system/node-upgrade
# says autoUpgrade=true, take ONE stateful-pool node whose kubelet-version label is behind targetVersion, cordon + drain it,
# and wait until it is empty before touching the next one. It does not know anything about zones or disks.
set -u
log() { echo "$(date -u +%FT%TZ) upgrade-controller: $*"; }
log "started (window: wed 02:00-06:00)"
while true; do
  auto=$(kubectl -n kube-system get configmap node-upgrade -o jsonpath='{.data.autoUpgrade}' 2>/dev/null)
  target=$(kubectl -n kube-system get configmap node-upgrade -o jsonpath='{.data.targetVersion}' 2>/dev/null)
  if [ "$auto" = "true" ] && [ -n "$target" ]; then
    cordoned=$(kubectl get nodes -l node-pool=stateful -o jsonpath='{range .items[?(@.spec.unschedulable==true)]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1)
    if [ -n "$cordoned" ]; then
      left=$(kubectl get pods -A --field-selector=spec.nodeName="$cordoned" -o jsonpath='{range .items[*]}{.metadata.ownerReferences[0].kind}{"\n"}{end}' 2>/dev/null | grep -vc '^DaemonSet$')
      if [ "${left:-0}" -gt 0 ]; then
        log "node $cordoned still has $left non-daemonset pod(s), retrying drain"
        kubectl drain "$cordoned" --ignore-daemonsets --delete-emptydir-data --timeout=20s >/dev/null 2>&1 || log "drain of $cordoned did not finish (timeout), will retry"
      else
        log "node $cordoned is empty: replacing with $target (simulated), keeping it cordoned until the new node is verified"
      fi
    else
      node=$(kubectl get nodes -l "node-pool=stateful,upgrade/kubelet-version!=$target" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
      if [ -n "$node" ]; then
        log "node $node is behind $target: cordon + drain"
        kubectl cordon "$node" >/dev/null 2>&1 || true
        kubectl drain "$node" --ignore-daemonsets --delete-emptydir-data --timeout=20s >/dev/null 2>&1 || log "drain of $node did not finish (timeout), will retry"
      else
        log "all stateful nodes at $target, nothing to do"
      fi
    fi
  else
    log "autoUpgrade=${auto:-unset}: paused"
  fi
  sleep 30
done
