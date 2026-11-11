#!/bin/sh
# dns-rebuild: rebuilds one replica of the internal DNS cluster in place.
# The old instance is stopped and its directory is wiped, a new configuration is rendered by dns-provision with the
# options from /etc/dns-provision/rebuild.conf, the new instance is started and checked.
#   dns-rebuild <replica>             rebuild the replica
#   dns-rebuild --dry-run <replica>   print the configuration a rebuild would render, touch nothing
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONF=/etc/dns-provision/rebuild.conf
INVENTORY=/etc/dns-provision/inventory
LOG=/var/log/dns-rebuild/rebuild.log
PROVISION=/opt/dns-provision/provision

dry=0
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi
replica=${1:-}
[ -n "$replica" ] || { echo "usage: dns-rebuild [--dry-run] <replica>" >&2; exit 2; }

setting() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$CONF" 2>/dev/null | tail -n 1; }
opts=$(setting provision_opts)
ticket=$(setting ticket)
check_name=$(setting healthcheck_name)
addr=$(awk -v r="$replica" '$1 == r { print $2 }' "$INVENTORY" 2>/dev/null)
[ -n "$addr" ] || { echo "dns-rebuild: replica $replica is not in $INVENTORY" >&2; exit 2; }

if [ $dry -eq 1 ]; then
  # shellcheck disable=SC2086  the options are a list of words
  exec "$PROVISION" --replica "$replica" $opts --stdout </dev/null
fi

[ "$(id -u)" = 0 ] || { echo "dns-rebuild: must be run as root (sudo dns-rebuild $replica)" >&2; exit 1; }
say() { line="$(date -u +%FT%TZ) dns-rebuild: $replica: $*"; echo "$line"; echo "$line" >> "$LOG"; }

say "start${ticket:+ ($ticket)}"
service "dns-$replica" stop >/dev/null 2>&1
rm -rf "/etc/dns-cluster/$replica"
say "old instance stopped, /etc/dns-cluster/$replica wiped"
say "provision $opts"
# shellcheck disable=SC2086
out=$("$PROVISION" --replica "$replica" $opts --out "/etc/dns-cluster/$replica" </dev/null 2>&1)
rc=$?
echo "$(date -u +%FT%TZ) $out" | tee -a "$LOG"
[ $rc -eq 0 ] || { say "FAILED: the configuration was not rendered"; exit 1; }
unbound-checkconf "/etc/dns-cluster/$replica/unbound.conf" >/dev/null 2>&1 || { say "FAILED: unbound-checkconf rejects the rendered configuration"; exit 1; }
service "dns-$replica" start >/dev/null 2>&1
say "new instance started"

# health check: the new instance is up and serves the internal zone
i=0; got=""
while [ $i -lt 20 ]; do
  got=$(dig +short +time=1 +tries=1 "@$addr" "$check_name" A </dev/null 2>/dev/null | head -n 1)
  case "$got" in [0-9]*) break ;; esac
  got=""; i=$((i + 1)); sleep 0.5
done
if [ -z "$got" ]; then say "FAILED: health check: $addr does not answer $check_name"; exit 1; fi
say "health check: $check_name -> $got OK"
say "done, the rebuild is successful"
