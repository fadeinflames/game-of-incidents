#!/bin/sh
# PID 1 of the sandbox: start the services as daemons (SysV scripts), then idle.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /run/sudo /run/lock /run/dns-cluster

# The OS upgrade of the replicas has been going on for three days: one rebuild a day. The log of the first three
# rebuilds is written with dates relative to today; the fourth one happens later, for real.
LOG=/var/log/dns-rebuild/rebuild.log
past_rebuild() {  # replica, days ago, time, own address, forwarder address, forwarder name
  d=$(date -u -d "$2 days ago" +%F)
  cat >> "$LOG" <<LINES
${d}T$3:02Z dns-rebuild: $1: start (OPS-3117)
${d}T$3:04Z dns-rebuild: $1: old instance stopped, /etc/dns-cluster/$1 wiped
${d}T$3:04Z dns-rebuild: $1: provision --os bookworm --auto-forwarders
${d}T$3:04Z dns-provision: $1: listen $4, forwarders: $5 ($6), picked automatically -> /etc/dns-cluster/$1/unbound.conf
${d}T$3:05Z dns-rebuild: $1: new instance started
${d}T$3:06Z dns-rebuild: $1: health check: db-primary.core.internal -> 10.20.0.11 OK
${d}T$3:06Z dns-rebuild: $1: done, the rebuild is successful
LINES
}
if [ ! -s "$LOG" ]; then
  past_rebuild ns1 3 09:14 127.0.0.21 127.0.0.22 ns2
  past_rebuild ns2 2 09:07 127.0.0.22 127.0.0.23 ns3
  past_rebuild ns3 1 09:21 127.0.0.23 127.0.0.24 ns4
fi

service extdns start >/dev/null 2>&1 || true
i=0
while ! dig +short +time=1 +tries=1 @127.0.0.201 . NS </dev/null 2>/dev/null | grep -q root-servers && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.25; done
for r in ns1 ns2 ns3 ns4; do service "dns-$r" start >/dev/null 2>&1 || true; done
for a in 21 22 23 24; do
  i=0
  while ! dig +short +time=1 +tries=1 "@127.0.0.$a" db-primary.core.internal A </dev/null 2>/dev/null | grep -q '^10\.' && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.25; done
done
service issuer start >/dev/null 2>&1 || true
service mon-agent start >/dev/null 2>&1 || true
# everything is up: break.sh waits for this marker
: > /run/.boot-complete
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
