#!/bin/sh
# pg-backup: physical backup of the shop database cluster for the backup storage mounted at /srv/backup.
# The copy is taken from the streaming replica (cluster 15/replica, port 5433), so the primary carries no extra load.
# The backup scheduler calls this script several times a day. Only the latest archive is kept here; the storage ships
# the older ones offsite.
set -eu
umask 027
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
DEST=/srv/backup
LOG=/var/log/pg-backup/backup.log

[ "$(id -un)" = postgres ] || { echo "pg-backup: must run as postgres" >&2; exit 1; }
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

stamp=$(date -u +%Y%m%d-%H%M%S)
out="$DEST/shop-base-$stamp.tar.gz"
log "backup started: pg_basebackup from the replica (port 5433), target $out"
if ! pg_basebackup -h /var/run/postgresql -p 5433 -U postgres -D - -Ft -X fetch -z -c fast > "$out.part" 2>> "$LOG"; then
  rm -f "$out.part"
  log "backup FAILED"
  exit 1
fi
mv "$out.part" "$out"
for old in "$DEST"/shop-base-*.tar.gz; do
  [ "$old" = "$out" ] || rm -f "$old"
done
log "backup finished: $out, $(du -h "$out" | cut -f1), sha256 $(sha256sum "$out" | cut -d' ' -f1)"
