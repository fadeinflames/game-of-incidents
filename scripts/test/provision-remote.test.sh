#!/usr/bin/env bash
# scripts/provision/provision.sh (the admin-machine side): arguments, --dry-run, pre-checks, the order of the steps and the exit codes.
# Runs a COPY of the script inside a scratch git repository with a fake `ssh` and `curl` in PATH: no network, nothing real is touched.
set -u
cd "$(dirname "$0")"
. ./helpers.sh
SRC=$(cd ../provision && pwd)/provision.sh
if ! command -v git >/dev/null 2>&1; then skip "git is not installed here"; finish; fi

# --- scratch repository with stub scripts, committed ---------------------------------------------------------------------
REPO="$TMP/repo"
mkdir -p "$REPO/scripts/provision" "$REPO/scripts/lib"
cp "$SRC" "$REPO/scripts/provision/provision.sh"
for f in scripts/provision/host-setup.sh scripts/provision/app-setup.sh scripts/deploy.sh; do printf '#!/usr/bin/env bash\nexit 0\n' > "$REPO/$f"; done
git -C "$REPO" init -q
git -C "$REPO" config core.autocrlf false
git -C "$REPO" add -A
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q -m init
PROV="$REPO/scripts/provision/provision.sh"

# --- fake ssh / curl ---------------------------------------------------------------------------------------------------
mkdir -p "$TMP/bin" "$TMP/fake"
cat > "$TMP/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
# logs every call; answers by the content of the remote command; behaviour is steered by FAKE_* variables
cmd="${*: -1}"; target="${*: -2:1}"
{ echo "TARGET=$target"; echo "CMD=$cmd"; echo "---"; } >> "$FAKE_LOG"
case "$cmd" in
  *"tar -x -C"*) n=$(ls "$FAKE_DIR"/tree.* 2>/dev/null | wc -l); cat > "$FAKE_DIR/tree.$((n + 1))"; exit 0 ;;
  *"cat > /home/wom/wom-restore.sql.gz"*) cat > "$FAKE_DIR/dump.upload"; exit 0 ;;
esac
case "$cmd" in
  true) [ -z "${FAKE_SSH_ERR:-}" ] || echo "$FAKE_SSH_ERR" >&2; exit "${FAKE_SSH_RC:-0}" ;;
  *"/etc/os-release"*) echo "${FAKE_OS:-debian 13}"; echo "${FAKE_UID:-0}"; exit 0 ;;
  "test -f /home/wom/wom-platform/.env"*) echo "${FAKE_HAS_ENV:-no}"; exit 0 ;;
  *"getent ahostsv4"*)
    for ip in ${FAKE_DOMAIN_IPS-203.0.113.10}; do echo "D $ip"; done
    echo "H 203.0.113.10"; exit 0 ;;
  *"grep -m1 '^WOM_DOMAIN='"*) echo "${FAKE_REMOTE_DOMAIN-game.example.com}"; exit 0 ;;
  *"host-setup.sh"*) exit "${FAKE_HOSTSETUP_RC:-0}" ;;
  *"app-setup.sh"*) exit "${FAKE_APPSETUP_RC:-0}" ;;
  *"scripts/deploy.sh"*) exit "${FAKE_DEPLOY_RC:-0}" ;;
esac
exit 0
FAKE
cat > "$TMP/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
[ "${FAKE_CURL_RC:-0}" = 0 ] || exit "$FAKE_CURL_RC"
echo '{"ok":true,"checks":{"db":true}}'
FAKE
chmod +x "$TMP/bin/ssh" "$TMP/bin/curl"
export FAKE_LOG="$TMP/fake/calls.log" FAKE_DIR="$TMP/fake"
export WOM_HEALTH_TRIES=2 WOM_HEALTH_SLEEP=0

reset_fake() {
  rm -f "$TMP"/fake/*
  unset FAKE_SSH_ERR FAKE_SSH_RC FAKE_OS FAKE_UID FAKE_HAS_ENV FAKE_DOMAIN_IPS FAKE_REMOTE_DOMAIN FAKE_HOSTSETUP_RC FAKE_APPSETUP_RC FAKE_DEPLOY_RC FAKE_CURL_RC
}
# run NAME ARGS...: runs the script in the scratch repo, sets $out (stdout+stderr) and $rc
run() {
  out=$(PATH="$TMP/bin:$PATH" bash "$PROV" "$@" 2>&1 < /dev/null); rc=$?
}
calls() { cat "$FAKE_LOG" 2>/dev/null || true; }
line_of() { calls | grep -n -- "$1" | head -n 1 | cut -d: -f1; }
COMMON=(--host 203.0.113.10 --domain game.example.com)

# --- arguments ---------------------------------------------------------------------------------------------------------
reset_fake
run --help
assert_eq "--help exits 0" 0 $rc
assert_contains "--help describes the usage" "$out" "Использование"
run
assert_eq "no arguments is refused" 2 $rc
assert_contains "the missing --host is named" "$out" "--host"
run --host game.example.com
assert_eq "no --domain is refused" 2 $rc
assert_contains "the missing --domain is named" "$out" "--domain"
run --host 203.0.113.10 --domain https://game.example.com/
assert_eq "a domain with a scheme is refused" 2 $rc
run --host 203.0.113.10 --domain nodot
assert_eq "a domain without a dot is refused" 2 $rc
run --host 203.0.113.10 --domain 999.1.1.1
assert_eq "an address with an octet over 255 is refused" 2 $rc
run --host game.example.com
assert_eq "no --domain with a host NAME is refused (only an IPv4 host may go without a domain)" 2 $rc
reset_fake
run --host 203.0.113.10 --dry-run
assert_eq "no --domain with an IPv4 host is accepted (no-domain mode)" 0 $rc
assert_contains "the no-domain plan says the DNS check is not needed" "$out" "DNS-проверка не нужна"
assert_contains "the no-domain plan passes the address to app-setup" "$out" "app-setup.sh --domain 203.0.113.10"
assert_eq "the no-domain dry-run does not call ssh" "" "$(calls)"
run --host -oProxyCommand=x --domain game.example.com
assert_eq "a host that looks like an ssh option is refused" 2 $rc
run "${COMMON[@]}" --port 99999
assert_eq "a port out of range is refused" 2 $rc
run "${COMMON[@]}" --port abc
assert_eq "a non-numeric port is refused" 2 $rc
run "${COMMON[@]}" --registration maybe
assert_eq "a bad --registration is refused" 2 $rc
run "${COMMON[@]}" --smoke everything
assert_eq "a bad --smoke is refused" 2 $rc
run "${COMMON[@]}" --ssh-user alice
assert_eq "a non-root ssh user is refused" 2 $rc
run "${COMMON[@]}" --ssh-key "$TMP/no-such-key"
assert_eq "a missing ssh key file is refused" 2 $rc
run "${COMMON[@]}" --dump "$TMP/no-such.sql.gz"
assert_eq "a missing dump file is refused" 2 $rc
run "${COMMON[@]}" --admin-email 'a b@x.y'
assert_eq "an email with a space is refused" 2 $rc
run "${COMMON[@]}" --contact-url 'https://t.me/x;rm'
assert_eq "a contact url with shell metacharacters is refused" 2 $rc
run "${COMMON[@]}" --admin-user '-evil'
assert_eq "an admin user starting with a dash is refused" 2 $rc
run "${COMMON[@]}" --frobnicate
assert_eq "an unknown option is refused" 2 $rc
run "${COMMON[@]}" --update --full
assert_eq "--update with --full is refused" 2 $rc
run "${COMMON[@]}" --registration
assert_eq "an option without a value is refused" 2 $rc
assert_eq "bad arguments never reach ssh" "" "$(calls)"

# --- sourcing does not run main; parse_args fills the settings ----------------------------------------------------------------
res=$(bash -c ". '$PROV'; parse_args --host=h.example --domain=A.Example.COM --port=2222 --registration=closed --update --yes; validate_args; echo \"\$HOST|\$DOMAIN|\$PORT|\$REGISTRATION|\$UPDATE|\$YES\"" 2>&1)
assert_eq "sourcing defines parse_args and --opt=value works" "h.example|a.example.com|2222|closed|1|1" "$res"

# --- --dry-run: a plan, no ssh --------------------------------------------------------------------------------------------------
reset_fake
run "${COMMON[@]}" --admin-user boss --registration closed --hostwatch --dry-run
assert_eq "--dry-run exits 0" 0 $rc
assert_contains "--dry-run prints the plan" "$out" "План"
assert_contains "the plan names host-setup" "$out" "host-setup.sh"
assert_contains "the plan names app-setup with its arguments" "$out" "app-setup.sh --domain game.example.com --registration closed --admin-user boss --hostwatch"
assert_contains "the plan names the health check" "$out" "https://game.example.com/api/health"
assert_eq "--dry-run does not call ssh" "" "$(calls)"
run "${COMMON[@]}" --dry-run --update
assert_contains "--dry-run --update names deploy.sh" "$out" "deploy.sh"
assert_eq "--dry-run --update does not call ssh" "" "$(calls)"

# --- the full path on a bare host ---------------------------------------------------------------------------------------------
reset_fake
run "${COMMON[@]}" --admin-user boss --admin-email boss@example.com --registration closed --contact-url https://t.me/goi --smoke full --hostwatch --yes
assert_eq "a full run succeeds" 0 $rc
assert_contains "the summary names the URL" "$out" "https://game.example.com"
assert_contains "the summary names the admin" "$out" "boss"
assert_contains "the summary tells how to read the password" "$out" "cat ~/.wom-admin-password"
assert_contains "the summary lists the manual follow-ups" "$out" "Что сделать вручную"
a=$(line_of "host-setup.sh"); b=$(line_of "app-setup.sh"); c=$(line_of "tar -x -C"); d=$(line_of "curl ")
if [ -n "$c" ] && [ -n "$a" ] && [ -n "$b" ] && [ -n "$d" ] && [ "$c" -lt "$a" ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$d" ]; then pass "order: delivery, host-setup, app-setup, health check"; else fail "order: delivery($c) < host-setup($a) < app-setup($b) < health($d)"; fi
assert_contains "app-setup runs as wom with the domain" "$(calls)" "TARGET=wom@203.0.113.10"
assert_contains "app-setup gets the platform arguments" "$(calls)" "app-setup.sh --domain game.example.com --registration closed --admin-user boss --admin-email boss@example.com --contact-url https://t.me/goi --smoke full --hostwatch"
assert_contains "--yes is passed on to app-setup (it confirms a changed domain there)" "$(calls)" "--hostwatch --yes"
assert_contains "app-setup runs with XDG_RUNTIME_DIR" "$(calls)" "XDG_RUNTIME_DIR=/run/user/"
assert_contains "wom's PATH includes ~/.local/bin (kind)" "$(calls)" '.local/bin'
assert_contains "the tree is committed on the host" "$(calls)" "git init -q"
assert_contains "the host .env is never committed" "$(calls)" "git rm -q --cached --ignore-unmatch -- .env"
assert_contains "the health check hits the domain" "$(calls)" "https://game.example.com/api/health"
assert_not_contains "no host-setup --adopt unless asked" "$(calls)" "host-setup.sh --adopt"
if [ -s "$TMP/fake/tree.1" ] && tar -tf "$TMP/fake/tree.1" | grep -q 'scripts/provision/host-setup.sh'; then pass "the delivered archive holds the tree from HEAD"; else fail "the delivered archive holds the tree from HEAD"; fi

# a custom port and key reach every ssh call
reset_fake
echo fake-key > "$TMP/key"
run "${COMMON[@]}" --port 2222 --ssh-key "$TMP/key" --yes
assert_eq "a run with a port and a key succeeds" 0 $rc
assert_contains "the summary command carries the port" "$out" "ssh -p 2222 wom@203.0.113.10 cat ~/.wom-admin-password"

# --adopt reaches host-setup
reset_fake
run "${COMMON[@]}" --adopt --yes
assert_contains "--adopt is passed to host-setup" "$(calls)" "host-setup.sh --adopt"

# the default admin name is shown when none is given
reset_fake
run "${COMMON[@]}" --yes
assert_contains "the default admin login is named" "$out" "Администратор:   admin"

# --- a dump is uploaded to wom before app-setup and removed after -------------------------------------------------------
reset_fake
printf 'fake dump' | gzip > "$TMP/d.sql.gz"
run "${COMMON[@]}" --dump "$TMP/d.sql.gz" --yes
assert_eq "a run with a dump succeeds" 0 $rc
assert_contains "app-setup is told where the dump is" "$(calls)" "--dump /home/wom/wom-restore.sql.gz"
if [ -s "$TMP/fake/dump.upload" ]; then pass "the dump was streamed over ssh"; else fail "the dump was streamed over ssh"; fi
assert_contains "the uploaded dump is removed after a successful run" "$(calls)" "rm -f /home/wom/wom-restore.sql.gz"

# --- pre-check failures ------------------------------------------------------------------------------------------------------
reset_fake
FAKE_SSH_RC=255 run "${COMMON[@]}" --yes
assert_eq "an unreachable host is refused" 2 $rc
assert_contains "the ssh-copy-id hint is given" "$out" "ssh-copy-id"
reset_fake
FAKE_SSH_RC=255 FAKE_SSH_ERR="WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" run "${COMMON[@]}" --yes
assert_eq "a changed host key is refused" 2 $rc
assert_contains "the changed host key hint names ssh-keygen -R" "$out" "ssh-keygen -R"
reset_fake
FAKE_OS="centos 9" run "${COMMON[@]}" --yes
assert_eq "an unsupported OS is refused" 2 $rc
assert_not_contains "nothing was delivered to a wrong OS" "$(calls)" "tar -x -C"
reset_fake
FAKE_OS="debian 12" run "${COMMON[@]}" --yes
assert_eq "Debian 12 is refused" 2 $rc
reset_fake
FAKE_UID=1000 run "${COMMON[@]}" --yes
assert_eq "a non-root login is refused" 2 $rc

# --- DNS --------------------------------------------------------------------------------------------------------------------------
reset_fake
FAKE_DOMAIN_IPS="198.51.100.7" run "${COMMON[@]}" --yes
assert_eq "an A record on another address stops the run" 2 $rc
assert_contains "the DNS message names the foreign address" "$out" "198.51.100.7"
assert_not_contains "no host-setup after a DNS mismatch" "$(calls)" "provision/host-setup.sh"
reset_fake
FAKE_DOMAIN_IPS="203.0.113.10 198.51.100.7" run "${COMMON[@]}" --yes
assert_eq "one foreign A record among several stops the run" 2 $rc
reset_fake
FAKE_DOMAIN_IPS="" run "${COMMON[@]}" --yes
assert_eq "a domain without A records stops the run" 2 $rc
assert_contains "the DNS message asks for an A record" "$out" "A-запись"
reset_fake
FAKE_DOMAIN_IPS="198.51.100.7" run "${COMMON[@]}" --yes --skip-dns-check
assert_eq "--skip-dns-check goes on with a warning" 0 $rc
assert_contains "--skip-dns-check warns" "$out" "ПРЕДУПРЕЖДЕНИЕ"

# --- dirty tree and uncommitted scripts ------------------------------------------------------------------------------------
reset_fake
echo "# local edit" >> "$REPO/scripts/deploy.sh"
run "${COMMON[@]}" --yes
assert_eq "a dirty tree is refused" 2 $rc
assert_contains "the dirty-tree message names the way out" "$out" "--allow-dirty"
assert_eq "a dirty tree is refused before ssh" "" "$(calls)"
run "${COMMON[@]}" --yes --allow-dirty
assert_eq "--allow-dirty goes on" 0 $rc
assert_contains "--allow-dirty says only HEAD is delivered" "$out" "только HEAD"
git -C "$REPO" checkout -q -- scripts/deploy.sh
reset_fake
git -C "$REPO" rm -q --cached scripts/provision/app-setup.sh
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q -m "drop app-setup"
run "${COMMON[@]}" --yes
assert_eq "a script missing from HEAD is refused" 2 $rc
assert_contains "the message names the missing file" "$out" "app-setup.sh"
git -C "$REPO" add scripts/provision/app-setup.sh
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q -m "restore app-setup"

# --- host-setup exit codes ---------------------------------------------------------------------------------------------------
reset_fake
FAKE_HOSTSETUP_RC=2 run "${COMMON[@]}" --yes
assert_eq "host-setup exit 2 becomes 2" 2 $rc
assert_not_contains "app-setup does not run after a failed host-setup" "$(calls)" "provision/app-setup.sh"
reset_fake
FAKE_HOSTSETUP_RC=3 run "${COMMON[@]}" --yes
assert_eq "host-setup exit 3 becomes 3" 3 $rc
assert_contains "exit 3 points at --adopt" "$out" "--adopt"
reset_fake
FAKE_HOSTSETUP_RC=1 run "${COMMON[@]}" --yes
assert_eq "another host-setup failure becomes 1" 1 $rc
reset_fake
FAKE_APPSETUP_RC=1 run "${COMMON[@]}" --yes
assert_eq "an app-setup failure becomes 1" 1 $rc
assert_not_contains "no success summary after a failed app-setup" "$out" "Что сделать вручную"

# --- health check from the admin machine ---------------------------------------------------------------------------------------
reset_fake
FAKE_CURL_RC=7 run "${COMMON[@]}" --yes
assert_eq "an unreachable /api/health fails the run" 1 $rc
assert_contains "the failure says what to check" "$out" "порты 80 и 443"

# --- an existing platform: update, with a confirmation -----------------------------------------------------------------------
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}"
assert_eq "an existing platform needs --yes without a terminal" 4 $rc
assert_contains "the run says it behaves as --update" "$out" "--update"
assert_not_contains "nothing is deployed without the confirmation" "$(calls)" "scripts/deploy.sh"
assert_not_contains "nothing is delivered without the confirmation" "$(calls)" "tar -x -C"
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --yes
assert_eq "an existing platform with --yes is updated" 0 $rc
assert_contains "the tree is delivered" "$(calls)" "tar -x -C"
assert_contains "deploy.sh runs as wom" "$(calls)" "bash scripts/deploy.sh"
assert_contains "deploy.sh runs in local mode" "$(calls)" "WOM_DEPLOY_MODE=local"
assert_not_contains "host-setup is not run on an existing platform" "$(calls)" "provision/host-setup.sh"
assert_not_contains "app-setup is not run on an existing platform" "$(calls)" "provision/app-setup.sh"
assert_not_contains "no DNS check on an update" "$(calls)" "getent ahostsv4"
assert_contains "the summary says it was an update" "$out" "обновление"
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --update
assert_eq "an explicit --update needs no --yes" 0 $rc
reset_fake
FAKE_HAS_ENV=yes run --host 203.0.113.10 --update
assert_eq "--update reads the domain from the host's .env" 0 $rc
assert_contains "the health check uses the domain from .env" "$(calls)" "https://game.example.com/api/health"
reset_fake
run "${COMMON[@]}" --update
assert_eq "--update on a bare host is refused" 2 $rc
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --dump "$TMP/d.sql.gz" --yes
assert_eq "--dump on an existing platform is refused" 2 $rc
assert_not_contains "nothing is delivered when --dump is refused" "$(calls)" "tar -x -C"
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --full --dump "$TMP/d.sql.gz" --yes
assert_eq "--dump with --full on an existing platform is refused" 2 $rc
assert_not_contains "no dump is uploaded to an existing platform" "$(calls)" "wom-restore.sql.gz"
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --yes
assert_contains "the sync protects local .env copies from --delete" "$(calls)" "P /.env.*"
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --full
assert_eq "--full on an existing platform needs --yes" 4 $rc
reset_fake
FAKE_HAS_ENV=yes run "${COMMON[@]}" --full --yes
assert_eq "--full --yes goes the full path" 0 $rc
assert_contains "--full runs host-setup" "$(calls)" "provision/host-setup.sh"
assert_contains "--full runs app-setup" "$(calls)" "provision/app-setup.sh"
reset_fake
FAKE_HAS_ENV=yes FAKE_DEPLOY_RC=1 run "${COMMON[@]}" --yes
assert_eq "a failing deploy.sh fails the update" 1 $rc

# --- the file itself ----------------------------------------------------------------------------------------------------------
if grep -q $'\r' "$SRC"; then fail "provision.sh has CRLF line endings"; else pass "provision.sh has LF line endings"; fi
assert_eq "provision.sh passes bash -n" 0 "$(bash -n "$SRC" 2>/dev/null; echo $?)"

finish
