#!/bin/sh
# SECRET reference solution: stop the charges, keep what is still intact, give the primary its own configuration back,
# book the refunds, rebuild the balances from the ledger, start the worker.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LEDGER=/var/lib/billing/billing.db

rinfo() { redis-cli -h 127.0.0.1 -p "$1" info replication </dev/null 2>/dev/null | tr -d '\r' | awk -F: -v k="$2" '$1 == k { print $2 }'; }

# 1. no new charges
service billing-worker stop >/dev/null 2>&1 || true

# 2. the snapshot written when the primary was stopped is still on disk: a copy goes aside before anything restarts
cp -p /var/lib/redis/balances/dump.rdb /root/balances-before-fix.rdb

# 3. the primary-role version of the file, saved by the configuration management when it replaced it
prev=$(ls -t /var/backups/cfgsync/redis/balances.conf.* 2>/dev/null | head -1)
[ -n "$prev" ] || { echo "solve: no previous version of the configuration file" >&2; exit 1; }
cp "$prev" /etc/redis/balances.conf
chown root:redis /etc/redis/balances.conf

# 4. restart with it: a writable master again (empty: the balances come from the ledger), the stale append-only
#    directory of the bad start is removed
service redis-balances restart >/dev/null 2>&1
i=0; role=
while [ $i -lt 30 ]; do
  role=$(rinfo 6379 role)
  [ "$role" = master ] && break
  i=$((i + 1)); sleep 1
done
[ "$role" = master ] || { echo "solve: the primary is not a master (role=$role)" >&2; exit 1; }
rm -rf /var/lib/redis/balances/appendonlydir

# 5. every charge the worker could not credit is refunded: the processor gets the request, the ledger the entry
grep 'not credited' /var/log/billing-worker/worker.log | grep -o 'ch_[0-9]*' | sort -u | xargs -r billing-refund

# 6. the balance of an account is the sum of its ledger entries
sqlite3 -readonly "$LEDGER" "SELECT 'SET balance:' || account_id || ' ' || SUM(amount_cents) FROM ledger GROUP BY account_id" </dev/null \
  | redis-cli -h 127.0.0.1 -p 6379 >/dev/null
[ "$(redis-cli -h 127.0.0.1 -p 6379 dbsize </dev/null)" = "40" ] || { echo "solve: the primary does not hold 40 balances" >&2; exit 1; }

# 7. the replicas reconnect on their own and take a full copy
i=0; up=0
while [ $i -lt 40 ]; do
  up=0
  for port in 6380 6381; do [ "$(rinfo $port master_link_status)" = up ] && up=$((up + 1)); done
  [ $up = 2 ] && break
  i=$((i + 1)); sleep 1
done
[ $up = 2 ] || { echo "solve: only $up of 2 replicas follow the primary" >&2; exit 1; }

# 8. billing is back
service billing-worker start >/dev/null 2>&1
sleep 3
echo "solve: done"
