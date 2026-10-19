#!/bin/sh
# egress-guard: forbids Kubernetes session bridges (wk8s*, named by the orchestrator) from starting connections to anything
# outside their own bridge: no internet, no LAN, no host services (FORWARD for traffic through the host, INPUT for the
# bridge gateway itself, the same pair for IPv6 when ip6tables works here). Replies to connections opened from outside
# (orchestrator -> API server, runner containers) still pass. Threat model R-7.
#
# Where the rules go: the network namespace that holds the docker bridges. With rootless docker that is RootlessKit's
# namespace: either the one `network_mode: host` gives us (classic setup) or, when the daemon runs with --detach-netns
# (Debian 13 packages), a detached namespace file that compose bind-mounts at /host-netns. We are inside RootlessKit's
# user namespace either way, so CAP_NET_ADMIN is valid for both.
#
# Heartbeat: after every pass that found or installed all rules the current unix time goes to $HEARTBEAT (a volume shared
# read-only with the orchestrator). The orchestrator refuses Kubernetes sessions while it is missing or stale, and the
# compose healthcheck reads the same file, so a guard that cannot install rules fails closed instead of silently open.
set -u
CHAIN=WOM-EGRESS
HEARTBEAT=${HEARTBEAT_FILE:-/run/wom-egress/heartbeat}
log() { echo "$(date -u +%FT%TZ) egress-guard: $*"; }
NS=""
if [ -e /host-netns ] && nsenter --net=/host-netns true 2>/dev/null; then NS="nsenter --net=/host-netns --"; fi
IPT="$NS $(command -v iptables-nft || command -v iptables)"
v6bin=$(command -v ip6tables-nft || command -v ip6tables || true)
IPT6=""; [ -n "$v6bin" ] && IPT6="$NS $v6bin"
CHAIN_IN=WOM-EGRESS-IN
# $1 = the iptables command of one address family
rules() {
  ipt=$1
  $ipt -N $CHAIN 2>/dev/null || true
  $ipt -C FORWARD -j $CHAIN 2>/dev/null || $ipt -I FORWARD 1 -j $CHAIN || return 1
  $ipt -C $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || $ipt -A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  $ipt -C $CHAIN -i wk8s+ ! -o wk8s+ -j DROP 2>/dev/null || $ipt -A $CHAIN -i wk8s+ ! -o wk8s+ -j DROP || return 1
  # a node must not open connections to the gateway address either (host services, the daemon's DNS forwarder on the bridge)
  $ipt -N $CHAIN_IN 2>/dev/null || true
  $ipt -C INPUT -j $CHAIN_IN 2>/dev/null || $ipt -I INPUT 1 -j $CHAIN_IN || return 1
  $ipt -C $CHAIN_IN -i wk8s+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || $ipt -A $CHAIN_IN -i wk8s+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  $ipt -C $CHAIN_IN -i wk8s+ -j DROP 2>/dev/null || $ipt -A $CHAIN_IN -i wk8s+ -j DROP || return 1
}
warned6=0
# IPv4 is mandatory; IPv6 is best effort (the sandbox bridges carry no IPv6 today, and ip6tables may be missing in the namespace)
ensure() {
  rules "$IPT" || return 1
  if [ -n "$IPT6" ] && ! rules "$IPT6"; then
    [ "$warned6" = 1 ] || log "ip6tables rules could not be installed (IPv6 stays unfiltered)"
    warned6=1
  fi
}
# tmp + mv: the orchestrator must never read a half-written file
beat() { date +%s > "$HEARTBEAT.tmp" && mv -f "$HEARTBEAT.tmp" "$HEARTBEAT" || log "cannot write heartbeat $HEARTBEAT"; }
# The rules stay on shutdown: sessions that are still running keep their egress block while the guard is restarted or
# redeployed. Only the heartbeat goes, so no new Kubernetes session starts until a guard confirms the rules again.
stop() { log "stopping: rules stay in place, heartbeat removed"; rm -f "$HEARTBEAT" "$HEARTBEAT.tmp"; exit 0; }
trap stop TERM INT
mkdir -p "$(dirname "$HEARTBEAT")"
# a heartbeat left by the previous container must not vouch for this one
rm -f "$HEARTBEAT" "$HEARTBEAT.tmp"
if ! ensure; then log "FAILED to install rules (${NS:-local netns}); check that the container is privileged and, with --detach-netns, that DOCKER_NETNS_FILE points at \$XDG_RUNTIME_DIR/dockerd-rootless/netns"; exit 1; fi
beat
log "active (${NS:-local netns}): new connections from wk8s* bridges to other interfaces are dropped"
while true; do
  sleep 30 &
  wait $!
  if ensure; then beat; else log "re-asserting rules failed"; fi
done
