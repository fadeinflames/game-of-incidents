#!/usr/bin/env bash
# deploy/hostwatch.sh must look at the database directory too (database-5): PGDATA_MOUNT of .env, else /srv/pgdata.
# Linux only (/proc/loadavg); a copy of the script runs against fake df/docker and a stub notify.sh: nothing is sent.
set -u
cd "$(dirname "$0")"
. ./helpers.sh
[ -r /proc/loadavg ] || { skip "no /proc/loadavg (Linux only)"; finish; }

mkdir -p "$TMP/tree/deploy" "$TMP/bin" "$TMP/home" "$TMP/pgdata" "$TMP/backups"
cp ../../deploy/hostwatch.sh "$TMP/tree/deploy/hostwatch.sh"
printf '#!/usr/bin/env bash\necho "$1" >> "%s/notified"\n' "$TMP" > "$TMP/tree/deploy/notify.sh"
printf 'PGDATA_MOUNT=%s\n' "$TMP/pgdata" > "$TMP/tree/.env"
printf 'TG_BOT_TOKEN=x\nTG_CHAT_ID=1\nBACKUP_DIR=%s\nSTATE_FILE=%s\n' "$TMP/backups" "$TMP/state" > "$TMP/home/.wom-hostwatch.env"
# fake df: every path is its own filesystem, 10 % full; the calls are logged
cat > "$TMP/bin/df" <<FAKE
#!/usr/bin/env bash
echo "\$2" >> "$TMP/df-calls"
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "dev-\$(echo "\$2" | tr / _) 100 10 90 10% \$2"
FAKE
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/bin/docker"
chmod +x "$TMP/bin/df" "$TMP/bin/docker"

HOME="$TMP/home" PATH="$TMP/bin:$PATH" bash "$TMP/tree/deploy/hostwatch.sh" >/dev/null 2>&1
calls=$(cat "$TMP/df-calls" 2>/dev/null)
assert_contains "the PGDATA_MOUNT directory is measured" "$calls" "$TMP/pgdata"

# without PGDATA_MOUNT in .env the default is /srv/pgdata (measured only where it exists, so only the list is checked here)
if grep -q 'srv/backups \$pgdata' "$TMP/tree/deploy/hostwatch.sh" && grep -q "pgdata=/srv/pgdata" "$TMP/tree/deploy/hostwatch.sh"; then
  pass "the default list ends with the database directory (/srv/pgdata)"
else
  fail "the default list ends with the database directory (/srv/pgdata)"
fi
finish
