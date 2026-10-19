#!/usr/bin/env bash
# One command that says whether the tree is fit to ship (instead of a CI service: the owner wants none; delivery is
# scripts/deploy.sh on the server, and this script is the gate you run before it). `make verify` calls it. deploy.sh does NOT.
#
# What it does, in order:
#   1. starts a throwaway PostgreSQL container (postgres:16-alpine, data on tmpfs) on a free 127.0.0.1 port, database "wom_test";
#   2. generates the Prisma client and applies the migrations to it (npm -w @wom/db run generate / deploy);
#   3. typecheck of every workspace that has a typecheck script;
#   4. tests of every workspace that has a test script, with DATABASE_URL pointing at that database and WOM_TEST_REQUIRE_DB=1,
#      so the orchestrator integration tests cannot be skipped silently (a missing database is a failure, not a green run);
#   5. the tests of the operations scripts (scripts/test/run.sh, no Docker needed) and the licence check of the dependencies;
#   6. `bash -n` on every *.sh in the tree, and shellcheck on deploy/, scripts/ and images/ when shellcheck is installed
#      (SHELLCHECK_SEVERITY=warning by default; scenario scripts are linted by `wom scenario lint`, not here);
#   7. removes the container, whatever happened (also on Ctrl-C and on a failed step).
# Every step runs even when an earlier one failed, except the database setup, which the tests depend on. The summary at the
# end lists the failed steps, and the exit code is non-zero if there is any. Nothing outside the container is modified, .env
# is not read (a DATABASE_URL in your shell is overridden), and the real database is never touched.
#
# Needs: docker (DOCKER_HOST is respected; the rootless socket of the current user is the default when it exists), node,
# npm with the dependencies installed (npm ci), bash.   VERIFY_PG_IMAGE=postgres:16-alpine   VERIFY_KEEP=1 keeps the container.
set -uo pipefail
cd "$(dirname "$0")/.."

NAME="wom-verify-pg-$$"
FAILED=()
STARTED=0

cleanup() {
  local rc=$?
  if [ "$STARTED" = 1 ] && [ "${VERIFY_KEEP:-0}" != 1 ]; then
    docker rm -f -v "$NAME" >/dev/null 2>&1 || echo "verify: warning: could not remove container $NAME (docker rm -f -v $NAME)" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step() { # name command...   runs the command, records a failure and goes on
  local name=$1; shift
  echo
  echo "== $name"
  if "$@"; then echo "-- ok: $name"; else echo "-- FAILED: $name"; FAILED+=("$name"); fi
}
die() { echo "verify: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed: the disposable PostgreSQL needs it"
command -v npm >/dev/null || die "npm is not installed"
[ -d node_modules ] || die "node_modules is missing: run npm ci first (verify.sh installs nothing)"
if [ -z "${DOCKER_HOST:-}" ] && [ -S "/run/user/$(id -u)/docker.sock" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi

# ---- 1. database ---------------------------------------------------------------------------------------------------
DB_NAME=wom_test
DB_PASSWORD=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
echo "== postgres: starting a disposable container ($NAME)"
docker run -d --name "$NAME" \
  -e POSTGRES_USER=wom -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB="$DB_NAME" \
  -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data \
  "${VERIFY_PG_IMAGE:-postgres:16-alpine}" -c fsync=off -c max_connections=200 >/dev/null || die "cannot start the postgres container"
STARTED=1
PORT=$(docker port "$NAME" 5432/tcp | head -n 1 | sed 's/.*://')
[ -n "$PORT" ] || die "docker did not report the published port of $NAME"

ready=0
for _ in $(seq 1 60); do
  # TCP, not the socket: during initdb the image runs a temporary server that listens on the socket only
  if docker exec "$NAME" psql -h 127.0.0.1 -U wom -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then docker logs --tail 20 "$NAME" >&2 || true; die "postgres did not become ready in 60 s"; fi
echo "   postgres is ready on 127.0.0.1:$PORT"

unset TEST_DATABASE_URL WOM_TEST_ALLOW_ANY_DB
export DATABASE_URL="postgresql://wom:${DB_PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}?schema=public"
export WOM_TEST_REQUIRE_DB=1
# the integration tests refuse a database without "test" in its name: check it here as well, so a later edit of DB_NAME fails fast
case "$DB_NAME" in *[Tt][Ee][Ss][Tt]*) ;; *) die "internal error: the database name \"$DB_NAME\" has no \"test\" in it" ;; esac

# ---- 2. client and migrations (the tests depend on them: stop here when they fail) ------------------------------------
step "prisma generate" npm -w @wom/db run generate --silent || true
step "prisma migrate deploy" npm -w @wom/db run deploy --silent || true
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "verify: FAILED before the tests could run: ${FAILED[*]}"
  exit 1
fi

# ---- 3-5. typecheck, tests, script tests -----------------------------------------------------------------------------
step "typecheck (all workspaces)" npm run typecheck --workspaces --if-present
step "tests (all workspaces; orchestrator integration included, WOM_TEST_REQUIRE_DB=1)" npm test --workspaces --if-present
step "tests of the operations scripts" bash scripts/test/run.sh
step "licences of the dependencies (no unknown or unreviewed licence)" node scripts/license-report.mjs --check

# ---- 6. shell scripts ------------------------------------------------------------------------------------------------
syntax_all() {
  local f bad=0 n=0
  while IFS= read -r -d '' f; do
    n=$((n + 1))
    bash -n "$f" || { echo "   bash -n failed: $f"; bad=1; }
  done < <(find . -name '*.sh' -not -path '*/node_modules/*' -not -path './.git/*' -not -path '*/.next/*' -print0)
  echo "   $n script(s) checked"
  return "$bad"
}
step "bash -n (every *.sh)" syntax_all

if command -v shellcheck >/dev/null; then
  lint_scripts() {
    local files=()
    while IFS= read -r -d '' f; do files+=("$f"); done < <(find deploy scripts images -name '*.sh' -not -path '*/node_modules/*' -print0)
    shellcheck -x -S "${SHELLCHECK_SEVERITY:-warning}" "${files[@]}"
  }
  step "shellcheck (deploy, scripts, images)" lint_scripts
else
  echo
  echo "== shellcheck: NOT INSTALLED, skipped (apt install shellcheck): only bash -n ran on the scripts"
fi

# ---- summary -------------------------------------------------------------------------------------------------------
echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "verify: FAILED (${#FAILED[@]}):"
  printf '   - %s\n' "${FAILED[@]}"
  exit 1
fi
echo "verify: all steps passed"
