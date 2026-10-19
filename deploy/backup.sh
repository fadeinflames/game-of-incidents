#!/usr/bin/env bash
# Logical backup of the platform database (nightly by the timer, and before every migration by scripts/deploy.sh).
# Keeps the newest BACKUP_KEEP (default 14) dumps with the same BACKUP_PREFIX in BACKUP_DIR (default /srv/backups):
# the nightly ones are wom-*.sql.gz, the deploy ones (BACKUP_PREFIX=pre-deploy-) pre-deploy-wom-*.sql.gz, rotated apart.
# The off-site copy is PULLED by another machine (rsync over ssh), see docs/runbook-prod-install.md §6.
# Exits non-zero on any failure (systemd marks wom-backup.service failed) and never rotates good dumps out for a bad one.
# Optional: BACKUP_AGE_RECIPIENT (an age public key) also writes an encrypted copy of .env next to the dump, because
# .env is the one thing a database dump cannot bring back (passwords, INTERNAL_TOKEN). Needs `age` on the host.
# A dump holds password hashes, scenario secrets and client addresses: the directory is 700 and every file 600, owned by the
# user who runs this script. The off-site rsync (docs/runbook-prod-install.md §6) logs in as that same user, so it still reads them.
set -euo pipefail
cd "$(dirname "$0")/.."
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
# what the caller passes on the command line (scripts/deploy.sh) wins over the same name in .env
args_prefix=${BACKUP_PREFIX:-}; args_keep=${BACKUP_KEEP:-}
umask 077
# only the BACKUP_* settings are taken from .env, and not exported: `source .env` with allexport would hand every platform
# secret (INTERNAL_TOKEN, POSTGRES_PASSWORD, ADMIN_PASSWORD) to docker, gzip and age. docker compose reads .env itself.
# A value in .env wins over the environment of the caller, as it did when .env was sourced.
setting() {
  local v
  v=$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true)
  if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "${!1:-$2}"; fi
}
BACKUP_DIR=$(setting BACKUP_DIR /srv/backups)
BACKUP_AGE_RECIPIENT=$(setting BACKUP_AGE_RECIPIENT "")
MIN_BYTES=$(setting BACKUP_MIN_BYTES 10240)
PREFIX=$args_prefix
KEEP=${args_keep:-$(setting BACKUP_KEEP 14)}
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" || echo "backup: warning: cannot chmod 700 $BACKUP_DIR (not owned by $(id -un)?): the dumps stay readable by whoever may enter it" >&2
# dumps written before this change were 644
find "$BACKUP_DIR" -maxdepth 1 \( -name '*wom-*.sql.gz' -o -name 'env-*.age' \) -exec chmod 600 {} + 2>/dev/null || true
stamp=$(date +%F-%H%M)
out="$BACKUP_DIR/${PREFIX}wom-$stamp.sql.gz"
fail() { echo "backup: FAILED: $*" >&2; rm -f "$out.tmp" "$BACKUP_DIR/env-$stamp.age.tmp"; exit 1; }

docker compose exec -T db pg_dump -U wom -d wom --no-owner | gzip -9 > "$out.tmp" || fail "pg_dump or gzip returned an error"
gunzip -t "$out.tmp" || fail "the archive does not pass gunzip -t"
size=$(wc -c < "$out.tmp")
[ "$size" -ge "$MIN_BYTES" ] || fail "the dump is only $size bytes (expected at least $MIN_BYTES)"
# pg_dump writes this trailer last: a dump cut short (full disk, killed container) can still be a valid gzip stream
gunzip -c "$out.tmp" | tail -n 20 | grep -c "PostgreSQL database dump complete" >/dev/null || fail "the dump has no completion trailer (truncated)"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ] && [ -z "$PREFIX" ]; then
  command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT is set but the age command is not installed (apt install age)"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$BACKUP_DIR/env-$stamp.age.tmp" .env || fail "age could not encrypt .env"
  mv "$BACKUP_DIR/env-$stamp.age.tmp" "$BACKUP_DIR/env-$stamp.age"
  ls -1t "$BACKUP_DIR"/env-*.age | tail -n +4 | xargs -r rm -f
fi

mv "$out.tmp" "$out"
ls -1t "$BACKUP_DIR"/"${PREFIX}"wom-*.sql.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup: $out ($(du -h "$out" | cut -f1))"
