#!/bin/sh
# SECRET reference solution: a second copy from the same archive, started without the standby settings; the deleted
# orders go from it into production as they were; the temporary instance is stopped and removed.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGAPPNAME
SOCK=/var/run/postgresql
R=/srv/restore
CSV=$R/orders-before-2026.csv
q() { runuser -u postgres -- psql -X -q -tA -h "$SOCK" -p "$1" -d shop -c "$2" </dev/null; }

# 1. the first copy has already replayed the DELETE: it is useless, and it must not stay attached to production
if [ -e "$R/pgdata/postmaster.pid" ]; then
  runuser -u postgres -- pg_ctl -D "$R/pgdata" -m fast -w stop </dev/null >/dev/null 2>&1 || true
fi
rm -rf "$R/pgdata"

# 2. the archive itself is intact: unpack it again
archive=$(ls -1 /srv/backup/shop-base-*.tar.gz | tail -n 1)
runuser -u postgres -- mkdir "$R/pgdata"
runuser -u postgres -- tar -xzf "$archive" -C "$R/pgdata"
runuser -u postgres -- chmod 700 "$R/pgdata"

# 3. before the first start: this copy must not become a standby of production
rm -f "$R/pgdata/standby.signal"
sed -i '/^primary_conninfo/d' "$R/pgdata/postgresql.auto.conf"

# 4. start it and make sure it is a standalone instance with the old orders
runuser -u postgres -- pg_ctl -D "$R/pgdata" -o "-c config_file=$R/restore.conf" -l "$R/restore.log" -w start </dev/null >/dev/null 2>&1
i=0; rec=""
while [ $i -lt 30 ]; do
  rec=$(q 5434 "SELECT pg_is_in_recovery()" 2>/dev/null || true)
  [ "$rec" = "f" ] && break
  i=$((i + 1)); sleep 1
done
[ "$rec" = "f" ] || { echo "solve: the temporary instance is still in recovery" >&2; exit 1; }
n=$(q 5434 "SELECT count(*) FROM orders WHERE created_at < '2026-01-01'")
[ "$n" = "6200" ] || { echo "solve: the copy has $n old orders, expected 6200" >&2; exit 1; }

# 5. only the deleted rows travel to production; everything written there after the backup stays untouched
runuser -u postgres -- psql -X -q -h "$SOCK" -p 5434 -d shop </dev/null \
  -c "\\copy (SELECT * FROM orders WHERE created_at < '2026-01-01' ORDER BY id) TO '$CSV' CSV"
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -p 5432 -d shop </dev/null \
  -c "\\copy orders FROM '$CSV' CSV"

# 6. clean up: no temporary instance, no copies of the data
runuser -u postgres -- pg_ctl -D "$R/pgdata" -m fast -w stop </dev/null >/dev/null 2>&1
rm -rf "$R/pgdata" "$CSV"
echo "solve: done"
