#!/bin/sh
# Build-time: the ledger, the card processor's history, the balances in the primary's snapshot, and three older
# snapshots in /var/backups/redis.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
W=/tmp/seed
mkdir -p $W && chmod 0777 $W
python3 /usr/local/sbin/seed.py $W
install -o billing -g billing -m 0644 $W/billing.db /var/lib/billing/billing.db
install -o cardproc -g cardproc -m 0644 $W/cardproc.db /var/lib/cardproc/cardproc.db

su -s /bin/sh redis -c "redis-server /etc/redis/balances.conf --daemonize yes --logfile $W/redis.log"
i=0
while [ "$(redis-cli -p 6379 ping 2>/dev/null)" != "PONG" ]; do
  i=$((i + 1)); [ $i -lt 40 ] || { echo "seed: redis did not start" >&2; cat $W/redis.log >&2; exit 1; }
  sleep 0.5
done
for slot in 1 2 3; do
  redis-cli -p 6379 < $W/state-$slot.redis > /dev/null
  redis-cli -p 6379 save > /dev/null
  install -o root -g root -m 0644 /var/lib/redis/balances/dump.rdb /var/backups/redis/balances-slot$slot.rdb
done
redis-cli -p 6379 < $W/state-final.redis > /dev/null
[ "$(redis-cli -p 6379 dbsize)" = "40" ] || { echo "seed: the primary does not hold 40 balances" >&2; exit 1; }
redis-cli -p 6379 shutdown save > /dev/null 2>&1 || true
i=0
while pgrep -x redis-server > /dev/null; do
  i=$((i + 1)); [ $i -lt 40 ] || { echo "seed: redis did not stop" >&2; exit 1; }
  sleep 0.5
done
[ -s /var/lib/redis/balances/dump.rdb ] || { echo "seed: no snapshot was written" >&2; exit 1; }
rm -rf $W
