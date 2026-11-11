#!/bin/sh
# SECRET. Six days ago the configuration management rendered the replica template into the configuration file of the
# balances primary (the inventory said "replica"). Nothing was restarted, so nothing happened. Tonight the primary is
# restarted: with "appendonly yes" it loads a non-existent append-only file instead of the snapshot and starts empty, and
# with "replicaof 127.0.0.1 6379" it is a read-only replica of itself. The billing worker reads missing balances as
# zero, charges the cards of the auto-recharge accounts, cannot write the new balance, and charges again.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONF=/etc/redis/balances.conf
LEDGER=/var/lib/billing/billing.db
PROC=/var/lib/cardproc/cardproc.db

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 180 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 90 s" >&2; exit 1; }

rinfo() { redis-cli -h 127.0.0.1 -p "$1" info "$2" </dev/null 2>/dev/null | tr -d '\r' | awk -F: -v k="$3" '$1 == k { print $2 }'; }
count() { sqlite3 -readonly "$1" "$2" </dev/null 2>/dev/null || echo 0; }

# the stand must be healthy before it is broken: a master with every balance, two replicas, a worker that rates usage
u0=$(count "$LEDGER" "SELECT COUNT(*) FROM ledger WHERE kind = 'usage'")
i=0; ok=0
while [ $i -lt 40 ]; do
  role=$(rinfo 6379 replication role); slaves=$(rinfo 6379 replication connected_slaves)
  keys=$(redis-cli -h 127.0.0.1 -p 6379 dbsize </dev/null 2>/dev/null)
  u1=$(count "$LEDGER" "SELECT COUNT(*) FROM ledger WHERE kind = 'usage'")
  if [ "$role" = master ] && [ "$slaves" = 2 ] && [ "$keys" = 40 ] && [ "$u1" -ge $((u0 + 2)) ]; then ok=1; break; fi
  i=$((i + 1)); sleep 1
done
[ $ok = 1 ] || { echo "break: FAILED, the stand is not healthy (role=$role replicas=$slaves keys=$keys usage $u0 -> $u1)" >&2; exit 1; }
c0=$(count "$PROC" "SELECT COUNT(*) FROM charges")

# what the configuration management left behind six days ago: its log, the previous version of the file, the new file
day=$(date -u -d '6 days ago' +%Y-%m-%d)
stamp=$(date -u -d '6 days ago' +%Y%m%d)-091244
install -d /var/backups/cfgsync/redis /var/log/cfgsync
cp -p "$CONF" "/var/backups/cfgsync/redis/balances.conf.$stamp"
{
  for ago in 9 8 7; do
    d=$(date -u -d "$ago days ago" +%Y-%m-%d)
    echo "${d}T09:12:41Z run started: inventory revision $(printf '%s' "$d" | md5sum | cut -c1-7)"
    echo "${d}T09:12:44Z run finished: 0 files changed, 0 services restarted"
  done
  echo "${day}T09:12:41Z run started: inventory revision $(printf '%s' "$day" | md5sum | cut -c1-7) (hosts re-imported from the asset database)"
  echo "${day}T09:12:43Z billing-01: redis instance 'balances': role in the inventory is now 'replica' (was 'primary')"
  echo "${day}T09:12:44Z billing-01: $CONF rendered from redis/replica.conf.tmpl, previous version saved to /var/backups/cfgsync/redis/balances.conf.$stamp"
  echo "${day}T09:12:44Z billing-01: redis-balances not restarted (restart policy: manual), the new file takes effect on the next start"
  echo "${day}T09:12:45Z run finished: 1 file changed, 0 services restarted"
  for ago in 5 4 3 2 1; do
    d=$(date -u -d "$ago days ago" +%Y-%m-%d)
    echo "${d}T09:12:41Z run started: inventory revision $(printf '%s' "$d" | md5sum | cut -c1-7)"
    echo "${d}T09:12:44Z run finished: 0 files changed, 0 services restarted"
  done
} > /var/log/cfgsync/cfgsync.log

cat > "$CONF" <<'EOF'
# Managed by cfgsync: local changes are overwritten on the next run.
# Template: redis/replica.conf.tmpl    Host: billing-01    Instance: balances    Role: replica

bind 127.0.0.1
port 6379
protected-mode yes
daemonize no
logfile /var/log/redis-balances/redis.log
dir /var/lib/redis/balances
dbfilename dump.rdb

# Persistence on a replica: append-only file, plus an occasional snapshot
appendonly yes
appendfsync everysec
save 900 1

# Replication: follow the primary of the balances cluster
replicaof 127.0.0.1 6379
replica-read-only yes
replica-serve-stale-data yes
EOF
chown root:redis "$CONF"; chmod 0644 "$CONF"
touch -d "${day}T09:12:44Z" "$CONF" 2>/dev/null || true
touch -d "$(date -u -d '1 day ago' +%Y-%m-%d)T09:12:44Z" /var/log/cfgsync/cfgsync.log 2>/dev/null || true
# the files nobody has touched since the cluster was set up
touch -d '212 days ago' /etc/redis/balances-r1.conf /etc/redis/balances-r2.conf /etc/default/redis-balances*   "/var/backups/cfgsync/redis/balances.conf.$stamp" 2>/dev/null || true

# tonight: the previous shift restarts the primary
service redis-balances restart >/dev/null 2>&1

i=0; role=; keys=
while [ $i -lt 30 ]; do
  role=$(rinfo 6379 replication role); keys=$(redis-cli -h 127.0.0.1 -p 6379 dbsize </dev/null 2>/dev/null)
  [ "$role" = slave ] && [ "$keys" = 0 ] && break
  i=$((i + 1)); sleep 1
done
[ "$role" = slave ] && [ "$keys" = 0 ] || { echo "break: FAILED, the primary did not come back empty and read-only (role=$role keys=$keys)" >&2; exit 1; }
[ -s /var/lib/redis/balances/dump.rdb ] || { echo "break: FAILED, the snapshot of the primary is gone" >&2; exit 1; }

# the damage must be visible: repeated charges that never reach a balance
i=0; c1=$c0
while [ $i -lt 60 ]; do
  c1=$(count "$PROC" "SELECT COUNT(*) FROM charges")
  [ "$c1" -ge $((c0 + 5)) ] && grep -q 'not credited' /var/log/billing-worker/worker.log 2>/dev/null && break
  i=$((i + 1)); sleep 1
done
[ "$c1" -ge $((c0 + 5)) ] || { echo "break: FAILED, the worker did not start charging cards ($c0 -> $c1 charges in 60 s)" >&2; exit 1; }
echo "break: done (the primary is empty and read-only, $((c1 - c0)) card charges so far)"
