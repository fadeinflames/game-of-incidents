#!/bin/sh
# SECRET. The last step of the OS upgrade of the DNS replicas: ns4 is rebuilt the way the first three were, with the
# options of the rebuild job. Those options give every rebuilt replica a forwarder, the next replica in the list.
# While ns4 was of the old generation the chain ns1 -> ns2 -> ns3 -> ns4 ended at a replica that resolved external
# names itself. After this rebuild ns4 forwards to ns1 and nobody is left to answer: internal names still resolve,
# external ones fail on all four replicas as soon as the cached answers expire.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

ext() { dig +short +time=2 +tries=1 "@127.0.0.$1" "$2" A </dev/null 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1; }

# the stand must be healthy before it is broken: the issuer can walk an order through the cluster
i=0; healthy=0
while [ $i -lt 30 ]; do
  if python3 /opt/issuer/issuer.py --check >/dev/null 2>&1 </dev/null && [ -n "$(ext 21 log-a.translog.example)" ]; then healthy=1; break; fi
  i=$((i + 1)); sleep 1
done
[ $healthy -eq 1 ] || { echo "break: FAILED, the cluster did not come up healthy" >&2; exit 1; }

# the fourth rebuild, exactly as the rollout does it
out=$(dns-rebuild ns4 </dev/null 2>&1) || { echo "break: FAILED, dns-rebuild ns4: $out" >&2; exit 1; }
grep -q 'forward-addr: 127.0.0.21' /etc/dns-cluster/ns4/unbound.conf || { echo "break: FAILED, ns4 was rendered without a forwarder" >&2; exit 1; }

# wait until the breakage is visible: the cached answers are gone, no replica resolves an external name the clients
# need, the issuer fails an order and says so in its log
end=$(( $(date +%s) + 80 ))
while [ "$(date +%s)" -lt "$end" ]; do
  alive=0
  for a in 21 22 23 24; do
    [ -n "$(ext "$a" vp-east.vantage.example)$(ext "$a" ingest.telemetry.example)" ] && alive=$((alive + 1))
  done
  if [ $alive -eq 0 ] && ! python3 /opt/issuer/issuer.py --check >/dev/null 2>&1 </dev/null \
     && grep -q 'FAILED' /var/log/issuer/issuer.log 2>/dev/null && grep -q 'push FAILED' /var/log/mon-agent/agent.log 2>/dev/null; then
    [ "$(ext 21 db-primary.core.internal)" = "10.20.0.11" ] || { echo "break: FAILED, internal names stopped resolving too" >&2; exit 1; }
    echo "break: done (ns4 rebuilt, external names fail on all four replicas)"
    exit 0
  fi
  sleep 2
done
echo "break: FAILED, external names still resolve 80 s after the rebuild of ns4" >&2
exit 1
