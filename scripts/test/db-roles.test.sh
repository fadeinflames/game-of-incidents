#!/usr/bin/env bash
# deploy/db-roles.sh with a fake `docker`: validation of WEB_DB_USER/WEB_DB_PASSWORD, and the password
# reaches psql on its stdin, never through the command line.
set -u
cd "$(dirname "$0")"
. ./helpers.sh

mkdir -p "$TMP/tree/deploy" "$TMP/bin"
cp ../../deploy/db-roles.sh ../../deploy/db-roles.sql "$TMP/tree/deploy/"
cat > "$TMP/bin/docker" <<FAKE
#!/usr/bin/env bash
echo "\$*" > "$TMP/docker-args"
cat > "$TMP/docker-stdin"
FAKE
chmod +x "$TMP/bin/docker"

run() { # .env contents on stdin
  rm -f "$TMP/docker-args" "$TMP/docker-stdin"
  cat > "$TMP/tree/.env"
  out=$(PATH="$TMP/bin:$PATH" DOCKER_HOST=unix:///nonexistent bash "$TMP/tree/deploy/db-roles.sh" 2>&1); rc=$?
}

run <<< "POSTGRES_PASSWORD=x"
assert_eq "no WEB_DB_PASSWORD: nothing to do, success" 0 $rc
[ ! -e "$TMP/docker-args" ] && pass "...and docker is not called" || fail "docker was called without a password"

run <<< "WEB_DB_PASSWORD=0123456789abcdef0123"
assert_eq "a password without a user is refused" 1 $rc
assert_contains "...with the reason" "$out" "but WEB_DB_USER is not"
run <<< "WEB_DB_USER=wom_web"
assert_eq "a user without a password is refused (compose would log in with the owner's password)" 1 $rc
assert_contains "...with the reason" "$out" "but WEB_DB_PASSWORD is not"

run <<< $'WEB_DB_USER=wom\nWEB_DB_PASSWORD=0123456789abcdef0123'
assert_eq "the owner role cannot be the web role" 1 $rc
run <<< $'WEB_DB_USER=Wom_Web;drop\nWEB_DB_PASSWORD=0123456789abcdef0123'
assert_eq "a role name that needs quoting is refused" 1 $rc
run <<< $'WEB_DB_USER=wom_web\nWEB_DB_PASSWORD=short'
assert_eq "a short password is refused" 1 $rc
run <<< $'WEB_DB_USER=wom_web\nWEB_DB_PASSWORD=0123456789abcdef@/:0123'
assert_eq "a password that would break the URL is refused" 1 $rc
[ ! -e "$TMP/docker-args" ] && pass "...none of them reached docker" || fail "docker was called for an invalid setting"

run <<< $'WEB_DB_USER=wom_web\nWEB_DB_PASSWORD="0123456789abcdef0123"'
assert_eq "a valid pair succeeds" 0 $rc
args=$(cat "$TMP/docker-args")
assert_contains "psql runs in the db container" "$args" "compose exec -T db psql -U wom -d wom"
assert_contains "the role name is passed as a psql variable" "$args" "web_role=wom_web"
assert_not_contains "the password is not on the command line" "$args" "0123456789abcdef0123"
assert_contains "the password is set by the first line of the stdin" "$(head -n 1 "$TMP/docker-stdin")" "\set web_password '0123456789abcdef0123'"
assert_contains "the SQL file follows on the stdin" "$(cat "$TMP/docker-stdin")" 'GRANT INSERT, UPDATE, DELETE ON "User", "Session", "Scenario", "ScenarioSubmission"'
sql=$(cat "$TMP/docker-stdin")
assert_not_contains "web never gets a write grant on TrainingSession" "$sql" 'DELETE ON "TrainingSession"'
assert_contains "the role is created without superuser" "$sql" "NOSUPERUSER"
finish
