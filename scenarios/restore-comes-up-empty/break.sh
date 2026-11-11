#!/bin/sh
# SECRET. The history of this incident, played for real:
#   1. the scheduled backup runs: pg_basebackup from the replica, so the archive carries standby.signal and primary_conninfo;
#   2. production keeps working: a partner batch is loaded, some orders change status;
#   3. an engineer deletes every order created before 2026 from production by mistake;
#   4. a colleague follows /srv/restore/README.md: unpacks the archive and starts it on port 5434. The instance comes up
#      as one more standby of production, replays the DELETE and has no rows to offer.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGAPPNAME
SOCK=/var/run/postgresql
R=/srv/restore

fail() { echo "break: FAILED, $*" >&2; exit 1; }
# one value from a cluster on this host, as the postgres superuser over the local socket
q() { runuser -u postgres -- psql -X -q -tA -h "$SOCK" -p "$1" -d shop -c "$2" </dev/null 2>/dev/null; }

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || fail "the container init did not finish in 60 s"

# the stand must be healthy first: the seed is in place, the replica streams, the storefront writes
i=0; ready=0
while [ $i -lt 40 ]; do
  old=$(q 5432 "SELECT count(*) FROM orders WHERE id <= 8400")
  rep=$(q 5432 "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")
  app=$(q 5433 "SELECT count(*) FROM orders WHERE id > 8400")
  if [ "$old" = "8400" ] && [ "$rep" = "1" ] && [ "${app:-0}" -ge 1 ] 2>/dev/null; then ready=1; break; fi
  i=$((i + 1)); sleep 1
done
[ $ready -eq 1 ] || fail "the stand is not healthy (seed rows: ${old:-?}, standbys: ${rep:-?}, app rows on the replica: ${app:-?})"

# 1. the scheduled backup, exactly as the scheduler runs it
runuser -u postgres -- /usr/local/sbin/pg-backup </dev/null || fail "the backup script failed: $(tail -n 3 /var/log/pg-backup/backup.log 2>/dev/null)"
archive=$(ls -1 /srv/backup/shop-base-*.tar.gz 2>/dev/null | tail -n 1)
[ -s "$archive" ] || fail "no archive in /srv/backup after the backup"
tar -tzf "$archive" 2>/dev/null | grep -q 'standby\.signal$' || fail "the archive has no standby.signal: was it taken from the replica?"
sleep 2

# 2. production lives on after the backup: a partner batch of 150 orders, shipped and refunded orders
awk 'BEGIN { for (i = 1; i <= 150; i++) printf "PRT-%06d,%d,%d,%s\n", i, 1 + (i * 11) % 48, 900 + (i * 613) % 41000, (i % 9 == 0) ? "paid" : "new" }' \
  | PGPASSWORD=sf-w7Kp2mQx PGAPPNAME=partner-import psql -X -q -h 127.0.0.1 -p 5432 -U shop -d shop \
      -c "\\copy orders (order_no, merchant_id, amount_cents, status) FROM pstdin CSV" >/dev/null 2>&1 \
  || fail "the partner batch was not loaded"
PGPASSWORD=sf-w7Kp2mQx PGAPPNAME=backoffice psql -X -q -h 127.0.0.1 -p 5432 -U shop -d shop </dev/null >/dev/null 2>&1 \
  -c "UPDATE orders SET status = 'shipped' WHERE id BETWEEN 8201 AND 8340 AND id % 5 = 0 AND status = 'paid'" \
  -c "UPDATE orders SET status = 'refunded' WHERE id BETWEEN 7000 AND 7600 AND id % 40 = 0 AND status = 'delivered'" \
  || fail "the status changes were not applied"
[ "$(q 5432 "SELECT count(*) FROM orders WHERE order_no LIKE 'PRT-%'")" = "150" ] || fail "the partner batch is incomplete"
sleep 2

# 3. the mistake: meant for a test stand, executed on production
out=$(PGPASSWORD=adm-4Rz8tLqV psql -X -h 127.0.0.1 -p 5432 -U shop_admin -d shop -c "DELETE FROM orders WHERE created_at < '2026-01-01'" </dev/null 2>&1)
[ "$out" = "DELETE 6200" ] || fail "the DELETE gave: $out"
sleep 5

# 4. the colleague's attempt, step by step as in /srv/restore/README.md
runuser -u postgres -- mkdir "$R/pgdata" || fail "cannot create $R/pgdata"
runuser -u postgres -- tar -xzf "$archive" -C "$R/pgdata" || fail "cannot unpack $archive"
runuser -u postgres -- chmod 700 "$R/pgdata"
runuser -u postgres -- pg_ctl -D "$R/pgdata" -o "-c config_file=$R/restore.conf" -l "$R/restore.log" start </dev/null >/dev/null 2>&1 \
  || fail "the temporary instance did not start: $(tail -n 5 "$R/restore.log" 2>/dev/null)"

# the breakage is visible when the temporary instance has replayed the DELETE and production has a second standby
i=0; gone=""; sb=""
while [ $i -lt 60 ]; do
  gone=$(q 5434 "SELECT count(*) FROM orders WHERE created_at < '2026-01-01'")
  sb=$(q 5432 "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")
  [ "$gone" = "0" ] && [ "$sb" = "2" ] && break
  i=$((i + 1)); sleep 1
done
[ "$gone" = "0" ] && [ "$sb" = "2" ] || fail "the temporary instance did not follow production (old rows there: ${gone:-?}, standbys: ${sb:-?})"
[ "$(q 5432 "SELECT count(*) FROM orders WHERE created_at < '2026-01-01'")" = "0" ] || fail "production still has the old orders"
echo "break: done (archive $archive, 6200 orders deleted, the temporary instance on 5434 follows production)"
