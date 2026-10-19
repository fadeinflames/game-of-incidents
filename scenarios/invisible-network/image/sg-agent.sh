#!/bin/sh
# sg-agent: the in-cluster stand-in for cloud VPC security groups. Runs on every worker (hostNetwork, NET_ADMIN),
# reads the rules from ConfigMap kube-system/security-groups every 10 s and programs the node's FORWARD chain:
#   ingress <tcp|any> cross-zone deny -> drop packets (TCP only for "tcp") from other zones' pod CIDRs to this node's pod CIDR
# Everything else is allowed. It knows nothing about services or pods, only zones and CIDRs, like the real thing.
set -u
IPT=$(command -v iptables-nft || command -v iptables)
CHAIN=SG-INGRESS
me=${NODE_NAME:?NODE_NAME}
log() { echo "$(date -u +%FT%TZ) sg-agent[$me]: $*"; }
$IPT -N $CHAIN 2>/dev/null || true
$IPT -C FORWARD -j $CHAIN 2>/dev/null || $IPT -I FORWARD 1 -j $CHAIN
log "started ($IPT), chain $CHAIN attached to FORWARD"
applied=""
while true; do
  rules=$(kubectl -n kube-system get configmap security-groups -o jsonpath='{.data.prod-workloads\.rules}' 2>/dev/null)
  my_zone=$(kubectl get node "$me" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' 2>/dev/null)
  my_cidr=$(kubectl get node "$me" -o jsonpath='{.spec.podCIDR}' 2>/dev/null)
  want=""
  proto=$(printf '%s\n' "$rules" | sed -nE 's/^ingress[[:space:]]+(tcp|any)[[:space:]]+cross-zone[[:space:]]+deny.*/\1/p' | head -n 1)
  if [ -n "$proto" ]; then
    for line in $(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.labels.topology\.kubernetes\.io/zone}={.spec.podCIDR}{"\n"}{end}' 2>/dev/null); do
      zone=${line%%=*}; cidr=${line#*=}
      [ -n "$zone" ] && [ "$zone" != "$my_zone" ] && [ -n "$cidr" ] && want="$want $proto,$cidr>$my_cidr"
    done
  fi
  if [ "$want" != "$applied" ]; then
    $IPT -F $CHAIN
    for pair in $want; do
      proto=${pair%%,*}; pair=${pair#*,}
      src=${pair%%>*}; dst=${pair#*>}
      if [ "$proto" = tcp ]; then
        $IPT -A $CHAIN -p tcp -s "$src" -d "$dst" -j DROP && log "DROP ingress tcp $src -> $dst (cross-zone deny)"
      else
        $IPT -A $CHAIN -s "$src" -d "$dst" -j DROP && log "DROP ingress $src -> $dst (cross-zone deny)"
      fi
    done
    [ -z "$want" ] && log "no deny rules: chain $CHAIN flushed (all ingress allowed)"
    applied="$want"
  fi
  sleep 10
done
