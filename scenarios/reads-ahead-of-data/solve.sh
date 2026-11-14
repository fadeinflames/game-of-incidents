#!/bin/sh
# SECRET reference solution: reads go back to the cluster that has all the data, the job that floods the change log is
# paused, and the migration is left to work its queue off. The write cutover waits until the queue is empty.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
API=http://127.0.0.1:8080
OLD="mysql --no-defaults -N -B -S /run/mysqld/db-old.sock tokens"
NEW="mysql --no-defaults -N -B -S /run/mysqld/db-new.sock tokens"

# 1. reads back to db-old
sed -i 's/^reads[[:space:]]*=.*/reads = db-old/' /etc/tokend/routing.conf
service tokend reload >/dev/null 2>&1
i=0; ok=0
while [ $i -lt 20 ]; do
  curl -q -s --max-time 3 "$API/admin/routing" </dev/null 2>/dev/null | grep -q '"reads": "db-old"' && { ok=1; break; }
  i=$((i + 1)); sleep 0.5
done
[ $ok = 1 ] || { echo "solve: tokend did not take the routing" >&2; exit 1; }

# 2. the cleanup stops feeding the change log (a running batch loop reads the setting again within two seconds)
sed -i 's/^enabled[[:space:]]*=.*/enabled = no/' /etc/tokend/cleanup.conf

# 3. a fresh token validates, and the queue of the migration goes down
t=$(curl -q -s --max-time 5 -H 'Content-Type: application/json' -d '{"integration": 7}' "$API/v1/tokens" </dev/null \
  | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')
code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/v1/tokens/$t" </dev/null || echo 000)
[ "$code" = 200 ] || { echo "solve: a fresh token answers $code" >&2; exit 1; }

queue() {
  p=$($NEW -e "SELECT applied_seq FROM _tablemover_job WHERE job = 'tokens-move'" </dev/null)
  $OLD -e "SELECT GREATEST(COALESCE(MAX(seq), 0) - $p, 0) FROM _tablemover_changes" </dev/null
}
i=0; ok=0
while [ $i -lt 12 ]; do
  a=$(queue); sleep 5; b=$(queue)
  if [ "$b" -le 30 ] || [ "$b" -le $((a - 30)) ]; then ok=1; break; fi
  i=$((i + 1))
done
[ $ok = 1 ] || { echo "solve: the queue of the migration does not shrink ($a -> $b)" >&2; exit 1; }
echo "solve: done (reads on db-old, cleanup paused, queue $a -> $b)"
