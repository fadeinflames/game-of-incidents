#!/bin/sh
# SECRET reference solution: the rebuild job stops asking for forwarders, then every replica is rebuilt in place,
# one at a time, the way the rollout does it. No static pins, no foreign resolvers.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONF=/etc/dns-provision/rebuild.conf

# 1. root cause: the option that gives every rebuilt replica a sibling as a forwarder
sed -i '/^provision_opts/s/[[:space:]]*--auto-forwarders//' "$CONF"
if grep '^provision_opts' "$CONF" | grep -q -- '--auto-forwarders'; then echo "solve: the option is still in $CONF" >&2; exit 1; fi
if dns-rebuild --dry-run ns1 </dev/null | grep -q '^forward-zone'; then echo "solve: a rebuild would still render a forward zone" >&2; exit 1; fi

# 2. the four replicas, one by one; each rebuild checks the new instance before the next one starts
for r in ns1 ns2 ns3 ns4; do
  dns-rebuild "$r" >/dev/null 2>&1 </dev/null || { echo "solve: dns-rebuild $r failed" >&2; exit 1; }
done

# 3. the clients recover by themselves
i=0
while [ $i -lt 30 ]; do
  if python3 /opt/issuer/issuer.py --check >/dev/null 2>&1 </dev/null && python3 /opt/mon-agent/mon_agent.py --check >/dev/null 2>&1 </dev/null; then
    echo "solve: done"; exit 0
  fi
  i=$((i + 1)); sleep 1
done
echo "solve: the clients still cannot resolve their names" >&2
exit 1
