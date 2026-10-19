#!/usr/bin/env bash
# scripts/provision/app-setup.sh against a scratch tree and fake docker / systemctl / curl / wom in PATH: argument parsing,
# --dry-run (a plan and no side effects), .env generation (mode 600, distinct non-empty secrets, nothing overwritten on a
# re-run), systemd units, the dump restore guard, health/smoke outcomes and exit codes. Nothing real is touched: HOME,
# XDG_RUNTIME_DIR and the database directory all live in a temporary directory.
set -u
cd "$(dirname "$0")"
. ./helpers.sh

REAL_SCRIPTS=$(cd .. && pwd)
REAL_ROOT=$(cd ../.. && pwd)
TREE="$TMP/tree"
BIN="$TMP/bin"
LOGS="$TMP/logs"
HOME_DIR="$TMP/home"
RUN_DIR="$TMP/run"
PGDATA="$TMP/pgdata"
mkdir -p "$BIN"

# ---- the scratch tree: the real script and units, a stub deploy.sh, a fake `wom` ----------------------------------------
build_tree() { # dir
  local t=$1
  rm -rf "$t"
  mkdir -p "$t/scripts/provision" "$t/deploy" "$t/node_modules/.bin" "$t/.git"
  cp "$REAL_SCRIPTS/provision/app-setup.sh" "$t/scripts/provision/app-setup.sh"
  cp "$REAL_ROOT/docker-compose.yml" "$t/docker-compose.yml"
  cp "$REAL_ROOT/deploy/docker-compose.prod.yml" "$t/deploy/"
  cp "$REAL_ROOT"/deploy/wom.service "$REAL_ROOT"/deploy/wom-backup.service "$REAL_ROOT"/deploy/wom-backup.timer \
     "$REAL_ROOT"/deploy/wom-hostwatch.service "$REAL_ROOT"/deploy/wom-hostwatch.timer "$REAL_ROOT/deploy/wom-failed@.service" "$t/deploy/"
  cat > "$t/scripts/deploy.sh" <<'STUB'
#!/usr/bin/env bash
# stub deploy: records that it ran, in which directory, whether .env existed and whether platform secrets leaked into its environment
{
  echo "DEPLOY cwd=$(pwd) env_present=$([ -f .env ] && echo yes || echo no)"
  if env | grep -qE '^(POSTGRES_PASSWORD|INTERNAL_TOKEN|ADMIN_PASSWORD)='; then echo "DEPLOY-SECRETS-IN-ENV"; fi
} >> "$FAKE_LOG_DIR/docker.log"
exit "${FAKE_DEPLOY_RC:-0}"
STUB
  cat > "$t/node_modules/.bin/wom" <<'FAKEWOM'
#!/usr/bin/env bash
echo "wom $*" >> "$FAKE_LOG_DIR/wom.log"
exit "${FAKE_WOM_RC:-0}"
FAKEWOM
  chmod +x "$t/scripts/deploy.sh" "$t/node_modules/.bin/wom"
}

# ---- fakes ---------------------------------------------------------------------------------------------------------------
cat > "$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG_DIR/docker.log"
case "$*" in
  "info --format"*) echo "[name=seccomp,profile=builtin name=rootless]" ;;
  "info") [ -z "${FAKE_DOCKER_DOWN:-}" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; } ;;
  "version --format"*) echo 29.8.1 ;;
  "compose version"*) echo 2.40.0 ;;
  "volume ls -q") printf '%s' "${FAKE_VOLUMES:-}" ;;
  "compose config"*) [ "${FAKE_CONFIG_RC:-0}" = 0 ] || { echo "error while interpolating" >&2; exit 1; } ;;
  "compose exec -T db psql -U wom -d wom -tAc "*to_regclass*) echo "${FAKE_HAS_SCHEMA:-f}" ;;
  "compose exec -T db psql -U wom -d wom -tAc "*'from "User" where role'*) echo "${FAKE_ADMINS:-1}" ;;
  "compose exec -T db psql -U wom -d wom -tAc "*'count(*) from "User"'*) echo "${FAKE_USERS:-0}" ;;
  "compose exec -T db psql -U wom -d postgres"*) echo "DROP-CREATE" >> "$FAKE_LOG_DIR/docker.log" ;;
  "compose exec -T db psql -U wom -d wom -v ON_ERROR_STOP=1 -q") cat > "$FAKE_LOG_DIR/restored.sql"; echo "RESTORE" >> "$FAKE_LOG_DIR/docker.log" ;;
  "compose exec -T web wget"*) [ -n "${FAKE_WEB_DOWN:-}" ] || echo '{"ok":true,"checks":{"db":true,"orchestrator":true,"disk":12,"egress":"ok"},"degraded":[]}' ;;
  "compose logs"*) echo "wom_caddy | obtaining certificate: error from the ACME server" ;;
esac
exit 0
FAKE
cat > "$BIN/systemctl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG_DIR/systemctl.log"
[ -z "${FAKE_NO_SYSTEMD:-}" ] || exit 1
exit 0
FAKE
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG_DIR/curl.log"
case "$*" in
  *--resolve*) [ "${FAKE_LOOPBACK:-ok}" = ok ] || exit 7 ;;
  *) [ "${FAKE_PUBLIC:-ok}" = ok ] || exit 7 ;;
esac
echo '{"ok":true,"checks":{"db":true,"orchestrator":true,"disk":12,"egress":"ok"},"degraded":[]}'
FAKE
cat > "$BIN/getent" <<'FAKE'
#!/usr/bin/env bash
[ -z "${FAKE_DNS_EMPTY:-}" ] || exit 2
echo "${FAKE_DNS_IP:-203.0.113.5}   STREAM $2"
FAKE
# ss: no listener (the real host may hold 5433); FAKE_BUSY_PORTS="5433 5434" makes those ports busy
cat > "$BIN/ss" <<'FAKE'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in *"sport = :"*) port=${a##*:} ;; esac; done
for p in ${FAKE_BUSY_PORTS:-}; do [ "$p" = "$port" ] && echo "LISTEN 0 4096 127.0.0.1:$p 0.0.0.0:*"; done
exit 0
FAKE
chmod +x "$BIN/ss"
cat > "$BIN/ip" <<'FAKE'
#!/usr/bin/env bash
echo "2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0"
FAKE
cat > "$BIN/node" <<'FAKE'
#!/usr/bin/env bash
echo v22.11.0
FAKE
cat > "$BIN/kind" <<'FAKE'
#!/usr/bin/env bash
echo "kind v0.33.0"
FAKE
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/flock"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/npm"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"
chmod +x "$BIN"/*

reset_state() {
  rm -rf "$HOME_DIR" "$RUN_DIR" "$PGDATA" "$LOGS" "$TREE/.env" "$TREE"/.env.*
  mkdir -p "$HOME_DIR" "$RUN_DIR" "$PGDATA" "$LOGS"
}

# run_setup ARGS...: the script as the service user would run it; stdout+stderr together, exit code in $rc
run_setup() {
  HOME="$HOME_DIR" XDG_RUNTIME_DIR="$RUN_DIR" PATH="$BIN:$PATH" FAKE_LOG_DIR="$LOGS" \
    WOM_PGDATA_DIR="$PGDATA" WOM_HEALTH_WAIT_SEC=3 WOM_HEALTH_POLL_SEC=1 WOM_DOCKER_WAIT_SEC=3 \
    bash "$TREE/scripts/provision/app-setup.sh" "$@" 2>&1
}
read_log() { cat "$LOGS/$1" 2>/dev/null || true; }
env_value() { grep -E "^$1=" "$TREE/.env" 2>/dev/null | tail -n 1 | cut -d= -f2-; }

build_tree "$TREE"
reset_state

# =========================================================================================================================
echo "arguments"
out=$(run_setup); rc=$?
assert_eq "no arguments: exit 2" 2 $rc
assert_contains "no arguments: asks for --domain" "$out" "--domain"

out=$(run_setup --domain); rc=$?
assert_eq "--domain without a value: exit 2" 2 $rc
out=$(run_setup --domain https://game.example.com --dry-run); rc=$?
assert_eq "a URL instead of a host name: exit 2" 2 $rc
out=$(run_setup --domain localhost --dry-run); rc=$?
assert_eq "a name without a dot: exit 2" 2 $rc
out=$(run_setup --domain game.example.com:8443 --dry-run); rc=$?
assert_eq "a host name with a port: exit 2" 2 $rc
out=$(run_setup --domain 203.0.113.10 --dry-run); rc=$?
assert_eq "an IPv4 address instead of a domain (no-domain mode): exit 0" 0 $rc
assert_contains "no-domain mode: the default admin e-mail is not built from the address" "$out" "admin@game.local"
out=$(run_setup --domain 999.0.0.1 --dry-run); rc=$?
assert_eq "an address with an octet over 255 is not accepted: exit 2" 2 $rc
out=$(run_setup --domain 1.2.3 --dry-run); rc=$?
assert_eq "an incomplete address is not accepted: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --registration maybe --dry-run); rc=$?
assert_eq "--registration maybe: exit 2" 2 $rc
assert_contains "--registration says what is allowed" "$out" "open или closed"
out=$(run_setup --domain game.example.com --smoke everything --dry-run); rc=$?
assert_eq "--smoke everything: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --admin-user 'a b' --dry-run); rc=$?
assert_eq "an admin name with a space: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --admin-email nobody --dry-run); rc=$?
assert_eq "a bad e-mail: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --contact-url 'https://t.me/a b' --dry-run); rc=$?
assert_eq "a contact URL with a space: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --contact-url 'http://t.me/x' --dry-run); rc=$?
assert_eq "a plain-http contact URL: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --contact-url 'mailto:a$b@x.org' --dry-run); rc=$?
assert_eq "a contact URL with a dollar sign: exit 2" 2 $rc
out=$(run_setup --domain game.example.com --frobnicate --dry-run); rc=$?
assert_eq "an unknown option: exit 2" 2 $rc
assert_contains "unknown option is named" "$out" "--frobnicate"
out=$(run_setup --domain game.example.com --dump "$TMP/nope.sql.gz" --dry-run); rc=$?
assert_eq "a missing dump file: exit 2" 2 $rc
echo "not gzip" > "$TMP/plain.sql"
out=$(run_setup --domain game.example.com --dump "$TMP/plain.sql" --dry-run); rc=$?
assert_eq "a dump that is not gzip: exit 2" 2 $rc
out=$(run_setup --help); rc=$?
assert_eq "--help: exit 0" 0 $rc
assert_contains "--help describes --domain" "$out" "--domain"
assert_eq "none of the failed runs touched the tree" "" "$(ls -A "$HOME_DIR")"

# =========================================================================================================================
echo "--dry-run"
printf 'select 1;\n' | gzip > "$TMP/ok.sql.gz"
out=$(run_setup --domain Game.Example.COM --registration closed --admin-user Boss --admin-email boss@example.com \
  --contact-url https://t.me/goi_help --dump "$TMP/ok.sql.gz" --smoke full --hostwatch --dry-run); rc=$?
assert_eq "dry-run exits 0" 0 $rc
assert_contains "dry-run prints a plan" "$out" "[план]"
assert_contains "dry-run lowercases the domain" "$out" "game.example.com"
assert_contains "dry-run mentions the .env it would create" "$out" "создам .env"
assert_contains "dry-run mentions the dump" "$out" "залью"
assert_contains "dry-run says nothing was changed" "$out" "ничего не изменено"
[ ! -e "$TREE/.env" ] && pass "dry-run: no .env" || fail "dry-run: no .env"
[ ! -e "$HOME_DIR/.config" ] && pass "dry-run: no systemd units" || fail "dry-run: no systemd units"
[ ! -e "$HOME_DIR/.wom-admin-password" ] && pass "dry-run: no password file" || fail "dry-run: no password file"
[ ! -e "$HOME_DIR/install-report.txt" ] && pass "dry-run: no report" || fail "dry-run: no report"
[ ! -e "$HOME_DIR/.wom-hostwatch.env" ] && pass "dry-run: no hostwatch config" || fail "dry-run: no hostwatch config"
calls="$(read_log docker.log)$(read_log systemctl.log)"
assert_not_contains "dry-run: docker compose up is not called" "$calls" "compose up"
assert_not_contains "dry-run: deploy.sh is not called" "$calls" "DEPLOY"
assert_not_contains "dry-run: no unit is enabled" "$calls" "enable"
assert_not_contains "dry-run: no daemon-reload" "$calls" "daemon-reload"
[ ! -e "$LOGS/curl.log" ] && pass "dry-run: no HTTP probe" || fail "dry-run: no HTTP probe"

# dry-run reports failed checks without stopping the plan, a real run stops with 2
out=$(FAKE_DOCKER_DOWN=1 run_setup --domain game.example.com --dry-run); rc=$?
assert_eq "dry-run with a dead docker still prints the plan (exit 0)" 0 $rc
assert_contains "dry-run names the failed check" "$out" "docker не отвечает"

# =========================================================================================================================
echo "refusals (exit 2, nothing changed)"
reset_state
mkdir -p "$TMP/rootbin"
printf '#!/usr/bin/env bash\ncase "$1" in -u) echo 0 ;; -un) echo root ;; *) /usr/bin/id "$@" ;; esac\n' > "$TMP/rootbin/id"
chmod +x "$TMP/rootbin/id"
out=$(PATH="$TMP/rootbin:$PATH" run_setup --domain game.example.com); rc=$?
assert_eq "as root: exit 2" 2 $rc
assert_contains "as root: says why" "$out" "от root"
out=$(FAKE_DOCKER_DOWN=1 run_setup --domain game.example.com); rc=$?
assert_eq "docker down: exit 2" 2 $rc
assert_contains "docker down: says so" "$out" "docker не отвечает"
out=$(FAKE_NO_SYSTEMD=1 run_setup --domain game.example.com); rc=$?
assert_eq "no systemd --user: exit 2" 2 $rc
assert_contains "no systemd --user: says so" "$out" "systemd --user недоступен"
out=$(XDG_RUNTIME_DIR="$TMP/nonexistent" HOME="$HOME_DIR" PATH="$BIN:$PATH" FAKE_LOG_DIR="$LOGS" WOM_PGDATA_DIR="$PGDATA" WOM_DOCKER_WAIT_SEC=3 \
  bash "$TREE/scripts/provision/app-setup.sh" --domain game.example.com 2>&1); rc=$?
assert_eq "no XDG_RUNTIME_DIR: exit 2" 2 $rc
assert_contains "no XDG_RUNTIME_DIR: says so" "$out" "XDG_RUNTIME_DIR"
[ ! -e "$TREE/.env" ] && pass "refusals: no .env was written" || fail "refusals: no .env was written"
assert_not_contains "refusals: nothing was deployed" "$(read_log docker.log)" "DEPLOY"

# =========================================================================================================================
echo "a first install"
reset_state
mkdir -p "$RUN_DIR/dockerd-rootless"; : > "$RUN_DIR/dockerd-rootless/netns"
out=$(run_setup --domain game.example.com); rc=$?
assert_eq "install exits 0" 0 $rc
assert_contains "install reports the URL" "$out" "https://game.example.com"
[ -f "$TREE/.env" ] && pass ".env exists" || fail ".env exists"
[ -f "$HOME_DIR/.wom-admin-password" ] && pass "password file exists" || fail "password file exists"
if modes_work; then
  assert_eq ".env is 600" 600 "$(stat -c %a "$TREE/.env")"
  assert_eq "password file is 600" 600 "$(stat -c %a "$HOME_DIR/.wom-admin-password")"
else
  skip "this filesystem ignores chmod: file modes are not checked"
fi
PG=$(env_value POSTGRES_PASSWORD); TOK=$(env_value INTERNAL_TOKEN); ADM=$(cat "$HOME_DIR/.wom-admin-password")
[ -n "$PG" ] && [ -n "$TOK" ] && [ -n "$ADM" ] && pass "all three secrets are non-empty" || fail "all three secrets are non-empty"
[ "$PG" != "$TOK" ] && [ "$PG" != "$ADM" ] && [ "$TOK" != "$ADM" ] && pass "the secrets differ from each other" || fail "the secrets differ from each other"
assert_eq "INTERNAL_TOKEN is 64 hex characters" 64 "${#TOK}"
assert_contains "DATABASE_URL carries the database password" "$(env_value DATABASE_URL)" "wom:$PG@127.0.0.1:5433"
assert_eq "COMPOSE_FILE is the production overlay" "docker-compose.yml:deploy/docker-compose.prod.yml" "$(env_value COMPOSE_FILE)"
assert_eq "WOM_DOMAIN" game.example.com "$(env_value WOM_DOMAIN)"
assert_eq "registration is open by default" true "$(env_value REGISTRATION_ENABLED)"
assert_eq "admin name defaults to admin" admin "$(env_value ADMIN_USERNAME)"
assert_eq "admin e-mail defaults to admin@domain" admin@game.example.com "$(env_value ADMIN_EMAIL)"
assert_eq "PGDATA_MOUNT points at the database directory" "$PGDATA" "$(env_value PGDATA_MOUNT)"
assert_eq "DOCKER_NETNS_FILE is the detected rootlesskit namespace" "$RUN_DIR/dockerd-rootless/netns" "$(env_value DOCKER_NETNS_FILE)"
assert_eq "DOCKER_SOCKET_PATH follows the runtime dir" "$RUN_DIR/docker.sock" "$(env_value DOCKER_SOCKET_PATH)"
assert_eq "CONTACT_URL is empty when not given" "" "$(env_value CONTACT_URL)"
assert_eq "the first-login password left .env once the admin existed" "" "$(env_value ADMIN_PASSWORD)"
assert_contains "the stack was told to forget the password" "$(read_log docker.log)" "compose up -d orchestrator"
assert_not_contains "the .env comment does not hide a password line" "$(cat "$TREE/.env")" "$ADM"

# no secret reaches the screen, a command line (fake logs), the report or the environment of deploy.sh
all_logs="$out$(read_log docker.log)$(read_log systemctl.log)$(read_log curl.log)$(read_log wom.log)$(cat "$HOME_DIR/install-report.txt" 2>/dev/null)"
assert_not_contains "no database password in output, logs or report" "$all_logs" "$PG"
assert_not_contains "no internal token in output, logs or report" "$all_logs" "$TOK"
assert_not_contains "no admin password in output, logs or report" "$all_logs" "$ADM"
assert_not_contains "deploy.sh did not inherit the secrets" "$(read_log docker.log)" "DEPLOY-SECRETS-IN-ENV"

# units
for u in wom.service wom-backup.service wom-backup.timer wom-failed@.service; do
  [ -f "$HOME_DIR/.config/systemd/user/$u" ] && pass "unit $u installed" || fail "unit $u installed"
done
[ ! -e "$HOME_DIR/.config/systemd/user/wom-hostwatch.timer" ] && pass "hostwatch units are not installed without --hostwatch" || fail "hostwatch units are not installed without --hostwatch"
assert_not_contains "the installed unit points at this tree, not at %h/wom-platform" "$(cat "$HOME_DIR/.config/systemd/user/wom.service")" "%h/wom-platform"
assert_contains "the installed unit points at this tree" "$(cat "$HOME_DIR/.config/systemd/user/wom.service")" "WorkingDirectory=$TREE"
sl=$(read_log systemctl.log)
assert_contains "daemon-reload" "$sl" "--user daemon-reload"
assert_contains "wom.service enabled" "$sl" "--user enable wom.service"
assert_contains "backup timer enabled and started" "$sl" "--user enable --now wom-backup.timer"
assert_contains "wom.service started after the deploy" "$sl" "--user start wom.service"
assert_not_contains "no hostwatch timer without --hostwatch" "$sl" "hostwatch"

# order: units before deploy, deploy before the health probes and the smoke test
dl=$(read_log docker.log)
assert_contains "deploy.sh ran in the tree, with .env present" "$dl" "DEPLOY cwd=$TREE env_present=yes"
deploy_line=$(grep -n '^DEPLOY ' "$LOGS/docker.log" | head -n 1 | cut -d: -f1)
wget_line=$(grep -n 'compose exec -T web wget' "$LOGS/docker.log" | head -n 1 | cut -d: -f1)
[ -n "$deploy_line" ] && [ -n "$wget_line" ] && [ "$deploy_line" -lt "$wget_line" ] && pass "health is probed after the deploy" || fail "health is probed after the deploy"
assert_contains "the public URL was probed" "$(read_log curl.log)" "https://game.example.com/api/health"
assert_contains "smoke: the Linux scenario ran" "$(read_log wom.log)" "scenario test scenarios/nginx-502-upstream"
assert_not_contains "smoke linux does not run the cluster scenario" "$(read_log wom.log)" "broken-probes"

# the report
rep=$(cat "$HOME_DIR/install-report.txt" 2>/dev/null)
assert_contains "report: URL" "$rep" "https://game.example.com"
assert_contains "report: where the password is" "$rep" ".wom-admin-password"
assert_contains "report: docker version" "$rep" "29.8.1"

# =========================================================================================================================
echo "a second run changes no secret"
before=$(grep -E '^(POSTGRES_PASSWORD|INTERNAL_TOKEN|DATABASE_URL)=' "$TREE/.env")
pw_before=$(cat "$HOME_DIR/.wom-admin-password")
printf 'MAX_SESSIONS_GLOBAL=7\n' >> "$TREE/.env"
out=$(run_setup --domain game.example.com); rc=$?
assert_eq "re-run exits 0" 0 $rc
assert_eq "secrets are byte-for-byte the same" "$before" "$(grep -E '^(POSTGRES_PASSWORD|INTERNAL_TOKEN|DATABASE_URL)=' "$TREE/.env")"
assert_eq "the password file is unchanged" "$pw_before" "$(cat "$HOME_DIR/.wom-admin-password")"
assert_eq "a key the owner added is kept" 7 "$(env_value MAX_SESSIONS_GLOBAL)"
assert_eq "ADMIN_PASSWORD did not come back" "" "$(env_value ADMIN_PASSWORD)"
assert_eq "the .env has each managed key once" 1 "$(grep -c '^WOM_DOMAIN=' "$TREE/.env")"
assert_contains ".env is reported as already right" "$out" "уже в нужном состоянии"

out=$(run_setup --domain game.example.com --registration closed --contact-url mailto:help@example.com --admin-user Boss --admin-email boss@example.com); rc=$?
assert_eq "re-run with new options exits 0" 0 $rc
assert_eq "registration closed" false "$(env_value REGISTRATION_ENABLED)"
assert_eq "contact URL set" mailto:help@example.com "$(env_value CONTACT_URL)"
assert_eq "admin name set (lower-cased)" boss "$(env_value ADMIN_USERNAME)"
assert_eq "admin e-mail set" boss@example.com "$(env_value ADMIN_EMAIL)"
assert_eq "secrets still the same" "$before" "$(grep -E '^(POSTGRES_PASSWORD|INTERNAL_TOKEN|DATABASE_URL)=' "$TREE/.env")"
out=$(run_setup --domain other.example.org); rc=$?
assert_eq "a changed domain without --yes is refused: exit 2" 2 $rc
assert_contains "the refusal names both domains" "$out" "game.example.com"
assert_eq "the domain was not touched" game.example.com "$(env_value WOM_DOMAIN)"
out=$(run_setup --domain other.example.org --dry-run); rc=$?
assert_contains "dry-run lists the refusal too" "$out" "--yes"
out=$(run_setup --domain other.example.org --yes); rc=$?
assert_eq "a new domain with --yes is accepted" 0 $rc
assert_eq "the domain was updated" other.example.org "$(env_value WOM_DOMAIN)"
assert_contains "a changed domain is said out loud" "$out" "домен меняется"
assert_eq "an option not named this time is not reset" false "$(env_value REGISTRATION_ENABLED)"

# =========================================================================================================================
echo "an .env that exists already"
reset_state
printf 'WOM_DOMAIN=old.example.com\nPOSTGRES_PASSWORD=keep-this-value\nCOMPOSE_FILE=docker-compose.yml\n' > "$TREE/.env"
out=$(run_setup --domain game.example.com --yes); rc=$?
assert_eq "exits 0" 0 $rc
assert_eq "the database password is kept, not invented" keep-this-value "$(env_value POSTGRES_PASSWORD)"
[ -n "$(env_value INTERNAL_TOKEN)" ] && pass "a missing INTERNAL_TOKEN is generated" || fail "a missing INTERNAL_TOKEN is generated"
assert_eq "no ADMIN_PASSWORD is added to an existing .env" "" "$(env_value ADMIN_PASSWORD)"
[ ! -e "$HOME_DIR/.wom-admin-password" ] && pass "no password file for an existing .env" || fail "no password file for an existing .env"
assert_eq "the prod overlay is appended to COMPOSE_FILE" "docker-compose.yml:deploy/docker-compose.prod.yml" "$(env_value COMPOSE_FILE)"
assert_eq "no PGDATA_MOUNT is invented for a running database" "" "$(env_value PGDATA_MOUNT)"
out=$(run_setup --domain game.example.com --dry-run); rc=$?
assert_contains "dry-run on an existing .env: managed keys only" "$out" "только управляемые ключи"

echo "the database directory already holds a database"
reset_state
mkdir -p "$PGDATA/base"; : > "$PGDATA/PG_VERSION"
out=$(run_setup --domain game.example.com); rc=$?
assert_eq "a new .env next to an old database: exit 1" 1 $rc
assert_contains "says that the database would not accept the new password" "$out" "POSTGRES_PASSWORD"
[ ! -e "$TREE/.env" ] && pass "no .env was written" || fail "no .env was written"
assert_not_contains "nothing was deployed" "$(read_log docker.log)" "DEPLOY"

echo "an old database volume is left alone"
reset_state
out=$(FAKE_VOLUMES="wom-platform_wom_db_data" run_setup --domain game.example.com); rc=$?
assert_eq "a new .env next to an old database volume: exit 1" 1 $rc
assert_contains "says that the password would not fit" "$out" "POSTGRES_PASSWORD"
[ ! -e "$TREE/.env" ] && pass "no .env was written next to the volume" || fail "no .env was written next to the volume"
assert_not_contains "nothing was deployed over the volume" "$(read_log docker.log)" "DEPLOY"

echo "an old .env with ADMIN_PASSWORD and no password file: the value is kept in the file"
reset_state
printf 'WOM_DOMAIN=game.example.com
POSTGRES_PASSWORD=x
INTERNAL_TOKEN=y
PGDATA_MOUNT=%s
ADMIN_PASSWORD=old-first-login
' "$PGDATA" > "$TREE/.env"
out=$(run_setup --domain game.example.com); rc=$?
assert_eq "exits 0" 0 $rc
assert_eq "ADMIN_PASSWORD left .env" "" "$(env_value ADMIN_PASSWORD)"
assert_eq "the password was saved before it was dropped" old-first-login "$(cat "$HOME_DIR/.wom-admin-password" 2>/dev/null)"
assert_not_contains "the password is not printed" "$out" "old-first-login"

# =========================================================================================================================
echo "restore of a dump"
reset_state
printf -- '-- dump\nINSERT INTO t VALUES (1);\n' | gzip > "$TMP/dump.sql.gz"
out=$(run_setup --domain game.example.com --dump "$TMP/dump.sql.gz"); rc=$?
assert_eq "restore into an empty database: exit 0" 0 $rc
assert_contains "the dump reached psql" "$(cat "$LOGS/restored.sql" 2>/dev/null)" "INSERT INTO t VALUES (1);"
dl=$(read_log docker.log)
drop_l=$(grep -n '^DROP-CREATE' "$LOGS/docker.log" | head -n 1 | cut -d: -f1)
rest_l=$(grep -n '^RESTORE' "$LOGS/docker.log" | head -n 1 | cut -d: -f1)
dep_l=$(grep -n '^DEPLOY ' "$LOGS/docker.log" | head -n 1 | cut -d: -f1)
[ -n "$drop_l" ] && [ -n "$rest_l" ] && [ -n "$dep_l" ] && [ "$drop_l" -lt "$rest_l" ] && [ "$rest_l" -lt "$dep_l" ] \
  && pass "order: recreate the database, restore, then deploy" || fail "order: recreate the database, restore, then deploy ($drop_l $rest_l $dep_l)"
assert_contains "web and orchestrator were stopped before the restore" "$dl" "compose stop web orchestrator"
[ ! -e "$HOME_DIR/.wom-restore-in-progress" ] && pass "the restore marker is gone after success" || fail "the restore marker is gone after success"

reset_state
out=$(FAKE_HAS_SCHEMA=t FAKE_USERS=5 run_setup --domain game.example.com --dump "$TMP/dump.sql.gz"); rc=$?
assert_eq "a database with users is not overwritten: exit 1" 1 $rc
assert_contains "says why" "$out" "уже есть данные"
assert_not_contains "no DROP was issued" "$(read_log docker.log)" "DROP-CREATE"
assert_not_contains "deploy did not start" "$(read_log docker.log)" "DEPLOY"

reset_state
: > "$HOME_DIR/.wom-restore-in-progress"
out=$(FAKE_HAS_SCHEMA=t FAKE_USERS=2 run_setup --domain game.example.com --dump "$TMP/dump.sql.gz"); rc=$?
assert_eq "an interrupted restore may be repeated: exit 0" 0 $rc
assert_contains "the database was recreated" "$(read_log docker.log)" "DROP-CREATE"

# =========================================================================================================================
echo "outcomes"
reset_state
out=$(FAKE_DEPLOY_RC=1 run_setup --domain game.example.com); rc=$?
assert_eq "a failed deploy: exit 1" 1 $rc
assert_contains "failed deploy: says what to do" "$out" "deploy.sh не прошёл"
assert_contains "failed deploy: the report says where it stopped" "$(cat "$HOME_DIR/install-report.txt")" "ОСТАНОВЛЕНО"
assert_not_contains "failed deploy: wom.service was not started" "$(read_log systemctl.log)" "start wom.service"

reset_state
out=$(FAKE_WEB_DOWN=1 run_setup --domain game.example.com); rc=$?
assert_eq "web that never answers: exit 1" 1 $rc
assert_contains "web down: says so" "$out" "web не ответил"

reset_state
out=$(FAKE_PUBLIC=fail FAKE_LOOPBACK=fail run_setup --domain game.example.com); rc=$?
assert_eq "the site is not reachable from outside: exit 4" 4 $rc
assert_contains "mentions the certificate or DNS" "$out" "сертификат"
assert_contains "the report lists it" "$(cat "$HOME_DIR/install-report.txt")" "Требует внимания"

reset_state
out=$(FAKE_PUBLIC=fail FAKE_LOOPBACK=ok run_setup --domain game.example.com); rc=$?
assert_eq "reachable through loopback only: exit 4" 4 $rc
assert_contains "points at the A record and the ports" "$out" "A-запись"

reset_state
out=$(FAKE_PUBLIC=fail FAKE_LOOPBACK=fail FAKE_DNS_EMPTY=1 run_setup --domain game.example.com); rc=$?
assert_eq "no DNS record: exit 4" 4 $rc
assert_contains "no DNS record: explains" "$out" "не resolve"

reset_state
out=$(FAKE_PUBLIC=fail FAKE_LOOPBACK=fail FAKE_DNS_IP=198.51.100.9 run_setup --domain game.example.com); rc=$?
assert_eq "DNS points elsewhere: exit 4" 4 $rc
assert_contains "DNS elsewhere: names both addresses" "$out" "198.51.100.9"

reset_state
out=$(FAKE_WOM_RC=1 run_setup --domain game.example.com); rc=$?
assert_eq "a failed smoke test: exit 4" 4 $rc
assert_contains "failed smoke: says so" "$out" "НЕ пройден"

reset_state
out=$(FAKE_ADMINS=0 run_setup --domain game.example.com); rc=$?
assert_eq "no administrator in the database: exit 4" 4 $rc
[ -n "$(env_value ADMIN_PASSWORD)" ] && pass "the password stays in .env when no admin exists" || fail "the password stays in .env when no admin exists"

echo "smoke modes"
reset_state
out=$(run_setup --domain game.example.com --smoke none); rc=$?
assert_eq "--smoke none exits 0" 0 $rc
[ ! -e "$LOGS/wom.log" ] && pass "--smoke none runs no scenario" || fail "--smoke none runs no scenario"
reset_state
out=$(run_setup --domain game.example.com --smoke full); rc=$?
assert_eq "--smoke full exits 0" 0 $rc
assert_contains "full: the Linux scenario" "$(read_log wom.log)" "scenarios/nginx-502-upstream"
assert_contains "full: the cluster scenario" "$(read_log wom.log)" "scenarios/broken-probes"

# =========================================================================================================================
echo "hostwatch"
reset_state
out=$(run_setup --domain game.example.com --hostwatch --smoke none); rc=$?
assert_eq "--hostwatch without Telegram settings exits 0" 0 $rc
[ -f "$HOME_DIR/.config/systemd/user/wom-hostwatch.timer" ] && pass "hostwatch units installed" || fail "hostwatch units installed"
[ -f "$HOME_DIR/.wom-hostwatch.env" ] && pass "a stub ~/.wom-hostwatch.env was created" || fail "a stub ~/.wom-hostwatch.env was created"
modes_work && assert_eq "the stub is 600" 600 "$(stat -c %a "$HOME_DIR/.wom-hostwatch.env")"
assert_not_contains "the timer is not enabled without Telegram settings" "$(read_log systemctl.log)" "enable --now wom-hostwatch.timer"
assert_contains "the report tells what to fill in" "$(cat "$HOME_DIR/install-report.txt")" "TG_BOT_TOKEN"
reset_state
printf 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=42\n' > "$HOME_DIR/.wom-hostwatch.env"
out=$(run_setup --domain game.example.com --hostwatch --smoke none); rc=$?
assert_eq "--hostwatch with Telegram settings exits 0" 0 $rc
assert_contains "the timer is enabled" "$(read_log systemctl.log)" "enable --now wom-hostwatch.timer"
assert_eq "existing Telegram settings are kept" "TG_BOT_TOKEN=123:abc" "$(sed -n 1p "$HOME_DIR/.wom-hostwatch.env")"

# =========================================================================================================================
echo "units of a tree that lives in ~/wom-platform are copied as they are"
reset_state
build_tree "$HOME_DIR/wom-platform"
TREE_SAVE=$TREE; TREE="$HOME_DIR/wom-platform"
out=$(run_setup --domain game.example.com --smoke none); rc=$?
assert_eq "install from ~/wom-platform exits 0" 0 $rc
cmp -s "$TREE/deploy/wom.service" "$HOME_DIR/.config/systemd/user/wom.service" && pass "wom.service is installed unchanged" || fail "wom.service is installed unchanged"
TREE=$TREE_SAVE

# =========================================================================================================================
echo "functions (sourced)"
(
  # shellcheck disable=SC1090
  . "$TREE/scripts/provision/app-setup.sh"
  case $- in *e*) echo "  FAIL sourcing the script leaves errexit on"; exit 1 ;; esac
  rc=0
  PATH="$BIN:$PATH"
  [ "$(pick_db_port)" = 5433 ] || { echo "  FAIL pick_db_port: 5433 is free, it is taken"; rc=1; }
  [ "$(FAKE_BUSY_PORTS="5433" pick_db_port)" = 5434 ] || { echo "  FAIL pick_db_port: 5433 busy, expected 5434"; rc=1; }
  [ "$(FAKE_BUSY_PORTS="5433 5434" pick_db_port)" = 5435 ] || { echo "  FAIL pick_db_port: 5433 and 5434 busy, expected 5435"; rc=1; }
  small=$(host_cpus(){ echo 2; }; host_mem_mb(){ echo 7900; }; capacity_profile)
  case "$small" in *MAX_K8S_SESSIONS=1*KIND_NODE_MEMORY_MB=2048*) ;; *) echo "  FAIL capacity_profile: a 2 CPU / 8 GB host gets the small profile"; rc=1 ;; esac
  big=$(host_cpus(){ echo 8; }; host_mem_mb(){ echo 64000; }; capacity_profile)
  [ -z "$big" ] || { echo "  FAIL capacity_profile: a big host keeps the production defaults"; rc=1; }
  ENV_FILE="$TMP/envtest"
  printf 'A=1\nB=2\nA=3\n# C=old\n' > "$ENV_FILE"
  env_set A 'x&y\z|w/q =v "q"' || rc=1
  [ "$(grep -c '^A=' "$ENV_FILE")" = 1 ] || { echo "  FAIL env_set keeps one A line"; rc=1; }
  [ "$(env_get A)" = 'x&y\z|w/q =v "q"' ] || [ "$(grep '^A=' "$ENV_FILE")" = 'A=x&y\z|w/q =v "q"' ] || { echo "  FAIL env_set writes the value verbatim"; rc=1; }
  [ "$(grep '^B=' "$ENV_FILE")" = "B=2" ] || { echo "  FAIL env_set leaves other keys"; rc=1; }
  env_set C 5 || rc=1
  [ "$(grep '^C=' "$ENV_FILE")" = "C=5" ] || { echo "  FAIL env_set appends a missing key (a comment is not a key)"; rc=1; }
  valid_domain game.example.com || { echo "  FAIL valid_domain accepts game.example.com"; rc=1; }
  valid_domain a-b.example.co.uk || { echo "  FAIL valid_domain accepts a subdomain chain"; rc=1; }
  ! valid_domain -bad.example.com || { echo "  FAIL valid_domain rejects a leading dash"; rc=1; }
  ! valid_domain 10.0.0.1 || { echo "  FAIL valid_domain rejects an IP address"; rc=1; }
  ! valid_domain 'a.com/path' || { echo "  FAIL valid_domain rejects a path"; rc=1; }
  valid_username ab.c || { echo "  FAIL valid_username accepts ab.c"; rc=1; }
  ! valid_username ab || { echo "  FAIL valid_username rejects 2 characters"; rc=1; }
  valid_email a@b.example || { echo "  FAIL valid_email accepts a@b.example"; rc=1; }
  ! valid_email 'a b@c.de' || { echo "  FAIL valid_email rejects a space"; rc=1; }
  valid_contact_url https://t.me/chat || { echo "  FAIL valid_contact_url accepts a Telegram link"; rc=1; }
  ! valid_contact_url 'https://x.y/a#b' || { echo "  FAIL valid_contact_url rejects #"; rc=1; }
  a=$(rand_hex 24); b=$(rand_hex 24)
  [ "${#a}" = 48 ] && [ "$a" != "$b" ] || { echo "  FAIL rand_hex gives 48 distinct hex characters"; rc=1; }
  exit $rc
)
src_rc=$?
if [ "$src_rc" = 0 ]; then pass "sourced functions: env_set, validators, rand_hex"; else fail "sourced functions (see above)"; fi
out=$(bash -c ". '$TREE/scripts/provision/app-setup.sh'; echo sourced-quietly" 2>&1)
assert_eq "sourcing does not run main" "sourced-quietly" "$out"

finish
