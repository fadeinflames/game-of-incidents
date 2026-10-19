#!/bin/sh
# Nightly application backup. Runs as user `backup` from /etc/cron.d/app-backup.
# tar data -> encrypt with the shared key -> /var/backups/app/app-<date>.tar.gz.enc
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
DATA=/srv/app/data
KEY=/etc/backup/backup.key
OUT=/var/backups/app
STAMP=$(date +%Y-%m-%d_%H%M%S)
TARGET="$OUT/app-$STAMP.tar.gz.enc"

echo "$(date -Is) backup: start (user=$(id -un))"
if [ ! -r "$KEY" ]; then
  echo "$(date -Is) backup: ERROR: can't read key $KEY (Permission denied)"
  exit 2
fi
# a private scratch directory per run: fixed file names in /tmp would belong to whoever ran the script first
ERR=$(mktemp -d /tmp/backup.XXXXXX) || { echo "$(date -Is) backup: ERROR: can't create a temporary directory in /tmp"; exit 5; }
trap 'rm -rf "$ERR"' EXIT
if ! tar -C "$DATA" -czf - . 2>"$ERR/tar.err" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY" -out "$TARGET" 2>"$ERR/enc.err"; then
  echo "$(date -Is) backup: ERROR: $(cat "$ERR/tar.err" "$ERR/enc.err" | head -3 | tr '\n' ' ')"
  rm -f "$TARGET"
  exit 3
fi
# tar errors do not fail the pipe: check them explicitly
if [ -s "$ERR/tar.err" ]; then
  echo "$(date -Is) backup: ERROR: $(head -3 "$ERR/tar.err" | tr '\n' ' ')"
  rm -f "$TARGET"
  exit 3
fi
SIZE=$(stat -c %s "$TARGET")
if [ "$SIZE" -lt 1024 ]; then
  echo "$(date -Is) backup: ERROR: archive too small ($SIZE bytes)"
  rm -f "$TARGET"
  exit 4
fi
echo "$(date -Is) backup: OK $TARGET ($SIZE bytes)"
# retention: keep 14 newest
ls -1t "$OUT"/app-*.tar.gz.enc 2>/dev/null | tail -n +15 | xargs -r rm -f
exit 0
