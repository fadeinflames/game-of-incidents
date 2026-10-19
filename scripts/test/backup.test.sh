#!/usr/bin/env bash
# deploy/backup.sh with a fake `docker`: file modes (security-runtime-11, infra-10) and no secrets in the child environment.
set -u
cd "$(dirname "$0")"
. ./helpers.sh

mkdir -p "$TMP/tree/deploy" "$TMP/bin" "$TMP/backups"
cp ../../deploy/backup.sh "$TMP/tree/deploy/backup.sh"
cat > "$TMP/tree/.env" <<ENV
INTERNAL_TOKEN=secret-token-value
BACKUP_DIR=$TMP/backups
BACKUP_MIN_BYTES=50
ENV
# fake docker: a dump with the completion trailer; records whether the platform secrets reached its environment
cat > "$TMP/bin/docker" <<FAKE
#!/usr/bin/env bash
env > "$TMP/docker-env"
printf -- '-- fake dump\n'
for i in \$(seq 1 40); do echo "INSERT INTO t VALUES (\$i);"; done
printf -- '-- PostgreSQL database dump complete\n'
FAKE
chmod +x "$TMP/bin/docker"
# a dump from before the change, world-readable
echo old > "$TMP/backups/wom-2020-01-01-0000.sql.gz"; chmod 644 "$TMP/backups/wom-2020-01-01-0000.sql.gz"
chmod 755 "$TMP/backups"

out=$(PATH="$TMP/bin:$PATH" DOCKER_HOST=unix:///nonexistent bash "$TMP/tree/deploy/backup.sh" 2>&1); rc=$?
assert_eq "backup succeeds" 0 $rc
assert_contains "backup reports the file" "$out" "backup: $TMP/backups/wom-"
dump=$(ls "$TMP"/backups/wom-20[2-9][0-9]-*.sql.gz | tail -n 1)
if [ -s "$dump" ]; then pass "dump exists"; else fail "dump exists"; fi
assert_not_contains "platform secrets are not exported to docker" "$(cat "$TMP/docker-env" 2>/dev/null)" "secret-token-value"
if modes_work; then
  assert_eq "dump is 600" 600 "$(stat -c %a "$dump")"
  assert_eq "backup directory is 700" 700 "$(stat -c %a "$TMP/backups")"
  assert_eq "an old dump is tightened to 600" 600 "$(stat -c %a "$TMP/backups/wom-2020-01-01-0000.sql.gz")"
else
  skip "this filesystem ignores chmod: file modes are not checked"
fi

echo "pre-deploy prefix"
out=$(PATH="$TMP/bin:$PATH" BACKUP_PREFIX=pre-deploy- BACKUP_KEEP=1 bash "$TMP/tree/deploy/backup.sh" 2>&1); rc=$?
assert_eq "prefixed backup succeeds" 0 $rc
assert_contains "prefixed name" "$out" "pre-deploy-wom-"
finish
