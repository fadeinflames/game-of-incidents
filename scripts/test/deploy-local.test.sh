#!/usr/bin/env bash
# scripts/deploy.sh in "local" mode (a tree delivered without a git remote, or WOM_DEPLOY_MODE=local): no fetch, no reset, no
# "local changes" check; everything after that is the usual deploy. Runs a COPY of the script in a scratch tree against a fake
# git, docker, npm, wom and flock: nothing real is touched and no Docker is needed.
set -u
cd "$(dirname "$0")"
. ./helpers.sh

TREE="$TMP/tree"
BIN="$TMP/bin"
LOGS="$TMP/logs"
mkdir -p "$BIN" "$LOGS"

build_tree() {
  rm -rf "$TREE"
  mkdir -p "$TREE/scripts/lib" "$TREE/deploy" "$TREE/images/tools" "$TREE/scenarios/demo" "$TREE/.git"
  cp ../deploy.sh "$TREE/scripts/deploy.sh"
  cp ../lib/drain.sh "$TREE/scripts/lib/drain.sh"
  : > "$TREE/images/tools/Dockerfile"
  : > "$TREE/scenarios/demo/scenario.yaml"
  printf '#!/usr/bin/env bash\necho "db-roles stub"\n' > "$TREE/deploy/db-roles.sh"
  printf 'INTERNAL_TOKEN=x\n' > "$TREE/.env"
}

# fake git: logs every call; the remote, the dirty state and an empty history come from FAKE_* variables
cat > "$BIN/git" <<'FAKE'
#!/usr/bin/env bash
echo "git $*" >> "$FAKE_LOG_DIR/git.log"
case "$*" in
  "remote get-url origin") [ -n "${FAKE_ORIGIN:-}" ] && { echo "git@example.com:org/repo.git"; exit 0; } || { echo "error: No such remote 'origin'" >&2; exit 2; } ;;
  "status --porcelain"*) printf '%s' "${FAKE_DIRTY:-}" ;;
  "status --short"*) printf '%s\n' "${FAKE_DIRTY:-}" ;;
  "rev-parse --short HEAD") [ -z "${FAKE_NO_COMMIT:-}" ] || exit 128; echo abc1234 ;;
  "log -1 --pretty=%s") [ -z "${FAKE_NO_COMMIT:-}" ] || exit 128; echo "the subject of the commit" ;;
esac
exit 0
FAKE
cat > "$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG_DIR/docker.log"
case "$*" in
  "compose build") [ -z "${FAKE_BUILD_FAIL:-}" ] || { echo "boom" >&2; exit 1; } ;;
  "compose ps -q orchestrator") ;;
  "inspect -f {{.State.Health.Status}} wom_egress_guard") echo healthy ;;
  "compose exec -T db psql"*) echo f ;;
  "compose exec -T web wget"*) echo '{"ok":true}' ;;
  "compose config --services") printf 'db\nweb\norchestrator\n' ;;
esac
exit 0
FAKE
cat > "$BIN/npm" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = ci ]; then
  mkdir -p node_modules/.bin
  printf '#!/usr/bin/env bash\necho "wom $*" >> "$FAKE_LOG_DIR/wom.log"\n[ "$2" = lint ] && echo "✓ demo"\nexit 0\n' > node_modules/.bin/wom
  chmod +x node_modules/.bin/wom
fi
exit 0
FAKE
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/flock"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"
chmod +x "$BIN"/*

# run_deploy ARGS...: stdout+stderr together
run_deploy() {
  (
    cd "$TREE" || exit 99
    PATH="$BIN:$PATH" FAKE_LOG_DIR="$LOGS" WOM_DEPLOY_LOCK="$TMP/deploy.lock" DRAIN_POLL_SEC=0 \
      bash scripts/deploy.sh "$@" 2>&1
  )
}
reset() { rm -f "$LOGS"/*; build_tree; }
git_log() { cat "$LOGS/git.log" 2>/dev/null || true; }

echo "no remote origin: local mode"
reset
out=$(run_deploy); rc=$?
assert_eq "local deploy exits 0" 0 $rc
assert_contains "says which mode it is in" "$out" "mode: local (no git remote)"
assert_contains "builds the working tree at the current commit" "$out" "abc1234"
assert_contains "ends with done" "$out" "deploy: done"
assert_not_contains "no git fetch in the output" "$out" "git: fetch"
assert_not_contains "git fetch was never called" "$(git_log)" "git fetch"
assert_not_contains "git reset was never called" "$(git_log)" "git reset"
assert_not_contains "the working tree is not inspected for changes" "$(git_log)" "git status"
for marker in "== host node_modules" "== scenario lint" "== scenario images" "== build images" "== egress-guard" "== migrations + seed" "== database role" "== restart stack" "== health" "health: {\"ok\":true}"; do
  assert_contains "the usual step still runs: $marker" "$out" "$marker"
done
assert_contains "the stack was restarted" "$(cat "$LOGS/docker.log")" "compose up -d --remove-orphans"
assert_contains "migrations ran in a one-off container" "$(cat "$LOGS/docker.log")" "compose run --rm --no-deps -T orchestrator"

echo "local changes do not block a local deploy"
reset
out=$(FAKE_DIRTY=" M apps/web/page.tsx" run_deploy); rc=$?
assert_eq "a dirty tree is built as it is: exit 0" 0 $rc
assert_not_contains "no 'local changes' refusal" "$out" "local changes"

echo "WOM_DEPLOY_MODE=local overrides an existing remote"
reset
out=$(FAKE_ORIGIN=1 WOM_DEPLOY_MODE=local run_deploy); rc=$?
assert_eq "exit 0" 0 $rc
assert_contains "local mode" "$out" "mode: local (no git remote)"
assert_not_contains "git fetch was never called" "$(git_log)" "git fetch"
assert_not_contains "git reset was never called" "$(git_log)" "git reset"

echo "a ref argument is ignored in local mode"
reset
out=$(run_deploy deadbeef); rc=$?
assert_eq "exit 0" 0 $rc
assert_contains "says so" "$out" "ref 'deadbeef' is ignored"
assert_not_contains "git reset was never called" "$(git_log)" "git reset"

echo "a tree that has no commit yet"
reset
out=$(FAKE_NO_COMMIT=1 run_deploy); rc=$?
assert_eq "exit 0" 0 $rc
assert_contains "says there is no commit" "$out" "no commit yet"

echo "with a remote the git flow is unchanged"
reset
out=$(FAKE_ORIGIN=1 run_deploy); rc=$?
assert_eq "git-mode deploy exits 0" 0 $rc
assert_not_contains "no local-mode line" "$out" "mode: local"
assert_contains "fetches and resets" "$out" "== git: fetch + reset to origin/main"
assert_contains "git fetch was called" "$(git_log)" "git fetch --prune origin"
assert_contains "git reset was called" "$(git_log)" "git reset --hard origin/main"
reset
out=$(FAKE_ORIGIN=1 FAKE_DIRTY=" M apps/web/page.tsx" run_deploy); rc=$?
assert_eq "git mode still refuses a dirty tree: exit 1" 1 $rc
assert_contains "git mode: says why" "$out" "local changes"
assert_not_contains "git mode: nothing was fetched" "$(git_log)" "git fetch"
reset
out=$(WOM_DEPLOY_MODE=git run_deploy); rc=$?
assert_eq "WOM_DEPLOY_MODE=git forces the git flow even without a remote" 0 $rc
assert_contains "git fetch was called" "$(git_log)" "git fetch --prune origin"

echo "refusals"
reset
out=$(WOM_DEPLOY_MODE=sideways run_deploy); rc=$?
assert_eq "an unknown mode: exit 1" 1 $rc
assert_contains "says what is allowed" "$out" "'local' or 'git'"
reset
rmdir "$TREE/.git"
out=$(run_deploy); rc=$?
assert_eq "a tree without .git: exit 1" 1 $rc
assert_contains "says that .git is required" "$out" "not a git repository"
assert_not_contains "nothing was built" "$out" "== platform images"
reset
rm -f "$TREE/.env"
out=$(run_deploy); rc=$?
assert_eq "a missing .env still stops the deploy first: exit 1" 1 $rc
assert_contains "no .env" "$out" "no .env"

echo "a failing local deploy tells what to do"
reset
out=$(FAKE_BUILD_FAIL=1 run_deploy); rc=$?
assert_eq "a failed build: exit 1" 1 $rc
assert_contains "the failure is named" "$out" "BUILD FAILED"
assert_contains "the epilogue is the local one" "$out" "NOT COMPLETED (local mode"
assert_not_contains "no rollback to a git ref is offered" "$out" "roll the code back"

finish
