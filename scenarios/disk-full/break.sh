#!/bin/sh
# SECRET. Nightly dumps without retention fill the data partition; the planned restart then fails.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
B=/var/lib/postgresql/backups
LOG=/var/log/pgdump.log

# The platform runs this script as soon as the container starts, while PID 1 may still be restoring the data
# directory onto the tmpfs and starting PostgreSQL. Filling the partition before that is over races with the
# restore: postgres then starts after our "stop" and stays up on a full disk, or the restore itself runs out
# of space and leaves a broken cluster. Wait for the init to finish first.
i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

mkdir -p "$B"; chown postgres:postgres "$B"

# Orders that arrived after the image was built: the grader's data-intact criterion expects them, so a cluster
# recreated from scratch (or from a copy of the build-time data) does not pass as "fixed".
su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d shop" >/dev/null <<'SQL' || { echo "break: FAILED, could not write the night orders" >&2; exit 1; }
INSERT INTO orders (created_at, amount, note)
SELECT date_trunc('day', now()) + interval '1 hour' + g * interval '1 minute', (random()*500)::numeric(10,2), 'night ' || g
FROM generate_series(1, 50) g;
SQL

service app stop >/dev/null 2>&1
service postgresql stop >/dev/null 2>&1

# Dumps that nobody deleted (4 MB each, one per night, today's first) until the partition is full, then fill the last
# pages. The pgdump.log lines are written here, not baked into the image, so their dates match the files.
i=0
while [ $i -le 60 ]; do
  d=$(date -d "$i days ago" +%F)
  f="$B/shop-$d.dump"
  if [ $i -eq 0 ]; then when="today 03:16"; else when="$i days ago 03:16"; fi
  if ! dd if=/dev/urandom of="$f" bs=1M count=4 2>/dev/null; then rm -f "$f"; break; fi
  touch -d "$when" "$f"
  {
    echo "$(date -d "$d 03:16" -Is) pgdump: shop -> $f OK"
    echo "$(date -d "$d 03:17" -Is) pgdump: uploaded to s3://backups-prod/db-01/shop-$d.dump OK (local copy kept)"
  } >> "$LOG"
  i=$((i + 1))
done
sort -o "$LOG" "$LOG"
dd if=/dev/zero of="$B/.tmp-$(date +%F).dump" bs=4k 2>/dev/null || true
chown -R postgres:postgres "$B"

# the planned restart at 03:40 (post-deploy config sync) is what fails on the full partition
{
  echo "$(date -d 'today 03:40:01' -Is) config-sync: postgresql.conf applied, restarting postgresql"
  echo "$(date -d 'today 03:40:04' -Is) config-sync: restart of postgresql failed, see /var/log/postgresql/postgresql-15-main.log"
} >> /var/log/config-sync.log
service postgresql start >/dev/null 2>&1 || true
sleep 1
service app start >/dev/null 2>&1 || true
pct=$(df --output=pcent /var/lib/postgresql | tail -1 | tr -dc '0-9')
if pg_isready -q -h 127.0.0.1 2>/dev/null; then
  echo "break: FAILED, postgres came up on a ${pct}% full partition" >&2
  exit 1
fi
echo "break: done (partition ${pct}% full, postgres down)"
