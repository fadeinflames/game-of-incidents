#!/usr/bin/env bash
# Deploy on the server: pull main, build images, dump the database, apply migrations + seed (one-off container), restart the stack.
# Usage (on the host):  [FORCE=1] [WOM_DEPLOY_MODE=local|git] ./scripts/deploy.sh [git-ref]      default: origin/main
#   FORCE=1  proceed although the working tree has local changes (they are destroyed by git reset --hard), although
#            sessions are still provisioning (they will fail) or although the pre-deploy dump failed.
#   Mode "local": the repository has NO remote "origin" (a tree delivered to the host by scripts/provision/provision.sh) or
#            WOM_DEPLOY_MODE=local. Nothing is fetched or reset, the "local changes" check is skipped, and whatever lies in the
#            working directory is built; everything after that (lock, drain, migrations, health, caddy) is the same.
#            The directory must still be a git repository (.git): provision.sh makes `git init` + a commit when it delivers the tree.
#            WOM_DEPLOY_MODE=git forces the git flow (an unset or empty value picks the mode by the remote).
#   DRAIN_MAX_SEC=1500  how long to wait for in-flight provisioning/checks (default covers PROVISIONING_TIMEOUT_MS + BREAK_TIMEOUT_MS + a queue).
#   DRAIN_POLL_SEC=5    seconds between two reads of the in-flight counter.
# Only one deploy runs at a time: a second start exits at once (flock on ${XDG_RUNTIME_DIR:-/tmp}/wom-deploy-<uid>.lock).
# Sandboxes are not touched: they live on outside compose and the orchestrator re-adopts them after restart.
# Deploy window: the tree is reset to the new ref BEFORE the build (the build needs the new sources), so a failed build
# leaves the old containers running on a tree that already holds the new code; the last lines printed say how to go back.
set -euo pipefail
cd "$(dirname "$0")/.."
# Two deploys at once would race on git reset --hard, the image builds, the migrations and the restart. The lock lives as
# long as this process (fd 9 is released by the kernel on any exit, even kill -9) and is taken before anything else is touched.
command -v flock >/dev/null || { echo "deploy: flock is not installed (util-linux): without it a second deploy cannot be refused — nothing was done"; exit 1; }
LOCK_FILE=${WOM_DEPLOY_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/wom-deploy-$(id -u).lock}
exec 9>"$LOCK_FILE" || { echo "deploy: cannot open the lock file $LOCK_FILE"; exit 1; }
if ! flock -n 9; then
  echo "deploy: another deploy is already running (lock $LOCK_FILE) — nothing was done. Wait for it to finish, or look at 'ps aux | grep deploy.sh'."
  exit 1
fi
# Logs of the steps live in a directory of the user (not in /tmp: a stale file of another user, or one planted there, would
# break the run or be written through a symlink). WOM_DEPLOY_LOG_DIR overrides it.
LOG_DIR=${WOM_DEPLOY_LOG_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/wom-deploy}
{ mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"; } || { echo "deploy: cannot create the log directory $LOG_DIR"; exit 1; }
REF=${1:-origin/main}
FORCE=${FORCE:-0}
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
# shellcheck source=lib/drain.sh
. scripts/lib/drain.sh

# .env is read by docker compose itself; it is deliberately NOT exported here, so npm and the dependencies' lifecycle
# scripts running on the host never see the platform secrets.
[ -f .env ] || { echo "no .env — copy .env.example and fill secrets"; exit 1; }

# .git is required in both modes. Checked as a path of THIS directory: from a tree without one, git would walk up and find
# some outer repository.
[ -e .git ] || { echo "deploy: this directory is not a git repository (no .git) — nothing was done. Deliver the tree with scripts/provision/provision.sh, or run git init and commit it."; exit 1; }
LOCAL=0
case "${WOM_DEPLOY_MODE:-auto}" in
  local) LOCAL=1 ;;
  git) ;;
  auto) git remote get-url origin >/dev/null 2>&1 || LOCAL=1 ;;
  *) echo "deploy: WOM_DEPLOY_MODE must be 'local' or 'git' (got '$WOM_DEPLOY_MODE') — nothing was done"; exit 1 ;;
esac

if [ "$LOCAL" != 1 ] && [ "$FORCE" != 1 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  echo "deploy: the working tree has local changes that 'git reset --hard' would destroy — commit or stash them, or run FORCE=1 ./scripts/deploy.sh"
  exit 1
fi

# a tree that was just `git init`-ed may have no commit yet: that must not crash the bookkeeping below
PREV=$(git rev-parse --short HEAD 2>/dev/null || echo none)
DONE=0; TOUCHED=0; MIGRATED=0; PRE_DUMP=""; DRAINING=0
# Drain mode lives in the orchestrator's memory: it ends when the container is recreated, but a deploy that leaves the
# orchestrator running (a web-only change) or fails halfway would keep refusing sessions for ever, so it is always
# switched off on exit. set_drain (scripts/lib/drain.sh) says whether the orchestrator really answered HTTP 200.
# ONE EXIT handler: a second `trap ... EXIT` replaces the first, which once dropped the rollback hints below
on_exit() {
  if [ "$DRAINING" = 1 ]; then
    DRAINING=0
    # rc 1 = an orchestrator without the route: it never started draining, nothing to undo
    set_drain false || { [ $? = 1 ] || echo "deploy: WARNING: drain mode could NOT be switched off — the orchestrator may keep refusing new sessions: restart it (docker compose restart orchestrator)"; }
  fi
  [ "$DONE" = 1 ] && return 0
  if [ "$LOCAL" = 1 ]; then
    echo "deploy: NOT COMPLETED (local mode: this run did not touch the tree, it is at $PREV)"
  else
    echo "deploy: NOT COMPLETED (the tree was at $PREV before this run, now at $(git rev-parse --short HEAD 2>/dev/null || echo none))"
  fi
  if [ "$TOUCHED" = 1 ]; then
    if [ "$LOCAL" = 1 ]; then
      echo "   fix the cause and run ./scripts/deploy.sh again; to go back, put the previous sources into the directory (sandboxes keep running)"
    else
      echo "   roll the code back:  ./scripts/deploy.sh $PREV     (sandboxes keep running)"
    fi
    if [ "$MIGRATED" = 1 ]; then
      echo "   migrations were APPLIED: if $PREV cannot work with the new schema, restore the dump first: ${PRE_DUMP:-the newest dump in /srv/backups} (docs/runbook-prod-install.md)"
    fi
  fi
  return 0
}
trap on_exit EXIT

if [ "$LOCAL" = 1 ]; then
  echo "mode: local (no git remote)"
  [ -n "${WOM_DEPLOY_MODE:-}" ] && [ "${WOM_DEPLOY_MODE}" != auto ] && echo "   (WOM_DEPLOY_MODE=local: git is not consulted even if a remote exists)"
  [ $# -eq 0 ] || echo "   the ref '$1' is ignored: the working directory is built as it is"
  echo "   building the working tree at $PREV: $(git log -1 --pretty=%s 2>/dev/null || echo 'no commit yet')"
else
  echo "== git: fetch + reset to $REF"
  git fetch --prune origin
  git reset --hard "$REF" --quiet
  echo "   at $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)   (was $PREV)"
fi

# A sandbox image that failed to build must stop the deploy here, before anything is restarted: otherwise the stack
# comes up healthy and every session of that scenario dies with "no such image".
image_build_failed() {
  tail -40 "$2"
  echo "deploy: IMAGE BUILD FAILED ($1) — old containers keep running, nothing was restarted (full log: $2)"
  exit 1
}

echo "== platform images (images/<name> -> wom-<name>:dev)"
for d in images/*/; do
  [ -f "${d}Dockerfile" ] || continue
  tag="wom-$(basename "$d"):dev"
  docker build -t "$tag" "$d" > "$LOG_DIR/image-build.log" 2>&1 || image_build_failed "$tag" "$LOG_DIR/image-build.log"
  echo "   built $tag"
done

echo "== host node_modules (the scenario CLI runs on the host with the workspace packages; --ignore-scripts: no dependency code runs here)"
if ! npm ci --ignore-scripts --silent --no-audit --no-fund > "$LOG_DIR/npm.log" 2>&1; then
  tail -20 "$LOG_DIR/npm.log"
  echo "deploy: npm ci FAILED — old containers keep running, nothing was restarted (full log: $LOG_DIR/npm.log)"
  exit 1
fi
[ -x ./node_modules/.bin/wom ] || { echo "deploy: npm ci FAILED (no ./node_modules/.bin/wom) — old containers keep running, nothing was restarted"; exit 1; }
# the generated client the host tests need (npm ci wipes it); the deploy itself does not depend on it
npm -w @wom/db exec prisma generate >/dev/null 2>&1 || echo "   warning: prisma generate failed on the host (only host-side tests need it)"

echo "== scenario lint (a scenario with errors would be skipped silently by the seed and never reach the catalog)"
# the local binary, not `npx wom`: npx would fetch a package of that name from the registry if node_modules is broken
if ! ./node_modules/.bin/wom scenario lint scenarios/*/ > "$LOG_DIR/lint.log" 2>&1; then
  grep -E '✗' "$LOG_DIR/lint.log" | tail -40 || true
  echo "deploy: SCENARIO LINT FAILED — old containers keep running, nothing was restarted (full log: $LOG_DIR/lint.log)"
  exit 1
fi
echo "   $(grep -c '^✓' "$LOG_DIR/lint.log" || true) scenario(s) clean"

echo "== scenario images (tag and build context come from scenario.yaml, the same values the sessions use)"
for d in scenarios/*/; do
  ./node_modules/.bin/wom scenario build "$d" > "$LOG_DIR/image-build.log" 2>&1 || image_build_failed "scenario $(basename "$d")" "$LOG_DIR/image-build.log"
  echo "   built $(basename "$d")"
done

echo "== build images (fails loudly: a failed build must never leave the old container running unnoticed)"
if ! docker compose build > "$LOG_DIR/build.log" 2>&1; then
  grep -vE "^#[0-9]+ (DONE|CACHED|transferring|sha256|extracting|resolve|\[internal\])" "$LOG_DIR/build.log" | tail -40
  echo "deploy: BUILD FAILED — old containers keep running, nothing was restarted (full log: $LOG_DIR/build.log)"
  exit 1
fi
grep -E "naming to|Built" "$LOG_DIR/build.log" | tail -5 || true

echo "== pre-pull public images referenced by scenarios (first heavy session must not wait for docker pull)"
# inside the new orchestrator image: it carries the docker CLI and the workspace packages, so the host needs no project code for this.
# Not fatal: a registry hiccup must not block a deploy, the images are pulled on first use anyway; but it is said out loud.
docker compose run --rm --no-deps -T orchestrator sh -c 'cd /app && npx tsx scripts/prepull-images.ts scenarios' 2>&1 | tail -3 \
  || echo "   warning: pre-pull failed — the first session of a heavy scenario will pull its images itself"

echo "== drain: refuse new sessions while the stack is being replaced (a no-op on an orchestrator that predates the route)"
# nothing to drain on a first install (no orchestrator container yet); otherwise anything but HTTP 200 is said out loud,
# because new sessions can still start while the stack is replaced (the counter below only sees those already running)
orch_running=0
if [ -n "$(docker compose ps -q orchestrator 2>/dev/null || true)" ]; then
  orch_running=1
  DRAINING=1
  set_drain true || { [ $? = 1 ] || echo "   WARNING: drain mode was NOT switched on — sessions started during the deploy may fail with the restart"; }
else
  echo "   no running orchestrator: nothing to drain"
fi
echo "== drain: wait for in-flight provisioning to finish (restarting the orchestrator mid-provisioning fails those sessions)"
DRAIN_MAX_SEC=${DRAIN_MAX_SEC:-1500}
[ "$FORCE" != 1 ] || DRAIN_MAX_SEC=0
# without a running orchestrator nothing is being provisioned, and a stopped stack must stay deployable
drained=0; drain_n=""
if [ "$orch_running" != 1 ]; then drained=1; echo "   no running orchestrator: nothing in flight"
elif wait_drained "$DRAIN_MAX_SEC"; then drained=1; fi
n=$drain_n
if [ "$drained" != 1 ]; then
  if [ "$FORCE" = 1 ]; then
    echo "   FORCE=1: ${n:-an unknown number of} session(s) still provisioning/checking will fail with the restart"
  elif [ -z "$n" ]; then
    echo "deploy: DRAIN FAILED — the number of provisioning/checking sessions could not be read for ${DRAIN_MAX_SEC}s (docker or the database does not answer) — nothing was restarted."
    echo "   Check 'docker compose ps' and 'docker compose logs db', or FORCE=1 ./scripts/deploy.sh to restart without the check."
    exit 1
  else
    echo "deploy: DRAIN TIMED OUT after ${DRAIN_MAX_SEC}s with $n session(s) still provisioning/checking — nothing was restarted."
    echo "   Run again later, or FORCE=1 ./scripts/deploy.sh to restart anyway (those sessions fail)."
    exit 1
  fi
fi

echo "== egress-guard (the orchestrator depends on a healthy guard: prove it BEFORE migrations and the restart,"
echo "   because a failed 'up' has already removed the old orchestrator container and leaves the platform without one)"
docker compose up -d egress-guard > "$LOG_DIR/up.log" 2>&1 || true
guard=""
for i in $(seq 1 30); do
  guard=$(docker inspect -f '{{.State.Health.Status}}' wom_egress_guard 2>/dev/null || true)
  case "$guard" in healthy|unhealthy) break ;; esac
  sleep 2
done
if [ "$guard" != "healthy" ]; then
  tail -5 "$LOG_DIR/up.log"
  docker logs --tail 10 wom_egress_guard 2>&1 || true
  echo "deploy: EGRESS GUARD NOT HEALTHY (${guard:-no health status}) — web and orchestrator were not restarted; check DOCKER_NETNS_FILE in .env"
  exit 1
fi

docker compose up -d --wait db 2>&1 | grep -E "Started|Running|Healthy|Error|error" || true
# a first install has no schema yet: there is nothing to dump. An EMPTY answer is a failed query, not a first install:
# it must not silently skip the dump of a live database
has_schema=$(docker compose exec -T db psql -U wom -d wom -tAc "select to_regclass('public.\"TrainingSession\"') is not null" 2>/dev/null | tr -d '[:space:]' || true)
if [ -z "$has_schema" ]; then
  echo "deploy: the database does not answer (cannot tell whether a schema exists) — nothing was restarted. Check 'docker compose logs db', or FORCE=1 to go on without a dump."
  [ "$FORCE" = 1 ] || exit 1
fi
if [ "$has_schema" = "t" ]; then
  echo "== database dump before the migrations (pre-deploy-*: the way back if a migration does not fit the old code)"
  if out=$(BACKUP_PREFIX=pre-deploy- BACKUP_KEEP=5 ./deploy/backup.sh); then
    echo "$out"
    PRE_DUMP=$(printf '%s\n' "$out" | sed -n 's/^backup: \(.*\.sql\.gz\) (.*/\1/p' | tail -n 1)
  else
    echo "deploy: PRE-DEPLOY DUMP FAILED — nothing was restarted. Free the disk / check the db container, or FORCE=1 to migrate without a fresh dump."
    [ "$FORCE" = 1 ] || exit 1
  fi
else
  echo "== no schema yet (first install): no dump"
fi

echo "== migrations + seed (one-off container from the new orchestrator image, BEFORE the services restart:"
echo "   the new code may query new tables at startup, so migrating after the restart crash-loops it)"
TOUCHED=1
docker compose run --rm --no-deps -T orchestrator sh -c 'cd /app && npm -w @wom/db run deploy --silent && npm -w @wom/db run seed --silent'
MIGRATED=1

echo "== database role of the web application (only when WEB_DB_USER/WEB_DB_PASSWORD are set in .env)"
bash deploy/db-roles.sh

echo "== live terminals (restarting the orchestrator drops them; the stands themselves keep running)"
live=$(running_count)
if [ -z "$live" ]; then echo "   cannot read the number of RUNNING sessions"
elif [ "$live" = 0 ]; then echo "   no RUNNING sessions"
else echo "   $live RUNNING session(s): their terminals disconnect for the seconds of the restart and have to reconnect"; fi

echo "== restart stack"
# checked explicitly: with the error swallowed, the health probe below would be the only (and slower) signal of a failed `up`
if ! docker compose up -d --remove-orphans > "$LOG_DIR/up.log" 2>&1; then
  tail -20 "$LOG_DIR/up.log"
  echo "deploy: STACK RESTART FAILED (full log: $LOG_DIR/up.log; egress-guard: docker logs wom_egress_guard)"
  exit 1
fi
grep -E "Started|Running|Recreate" "$LOG_DIR/up.log" || true

echo "== health (inside the compose network: production publishes nothing but Caddy)"
out=""
for i in $(seq 1 60); do
  out=$(docker compose exec -T web wget -qO- -T 3 http://127.0.0.1:3000/api/health 2>/dev/null || true)
  echo "$out" | grep -q "\"ok\":true" && break
  sleep 2
done
if echo "$out" | grep -q "\"ok\":true"; then echo "health: $out"; else echo "health: FAILED: $out"; exit 1; fi
# Caddyfile: it is bind-mounted as a single file, and `git reset --hard` replaces the file (a new inode) while the
# container keeps the old one, so neither `up -d` nor `caddy reload` ever sees the edit. Compare what the container really
# reads with the file on the host (sha256) and restart the container when they differ: a restart re-opens the path.
if docker compose config --services 2>/dev/null | grep -x caddy >/dev/null; then
  echo "== caddy (is the Caddyfile in the container the one on disk?)"
  host_sum=$(sha256sum deploy/Caddyfile | cut -d' ' -f1)
  cont_sum=$(docker compose exec -T caddy sha256sum /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1 || true)
  if [ "$host_sum" = "$cont_sum" ]; then
    echo "   Caddyfile unchanged"
  else
    # validate with a throwaway container first: a broken file would send the restarted caddy into a crash loop, and with it the whole site
    caddy_image=$(docker inspect -f '{{.Config.Image}}' wom_caddy 2>/dev/null || echo caddy:2-alpine)
    domain=$(docker compose exec -T caddy printenv WOM_DOMAIN 2>/dev/null | tr -d '\r' || true)
    if ! docker run --rm -e "WOM_DOMAIN=${domain:-example.invalid}" -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" \
         caddy validate --config /etc/caddy/Caddyfile > "$LOG_DIR/caddy.log" 2>&1; then
      tail -10 "$LOG_DIR/caddy.log"
      echo "deploy: the new Caddyfile does NOT VALIDATE — caddy was not restarted and keeps serving the old config (full log: $LOG_DIR/caddy.log)"
      exit 1
    fi
    echo "   Caddyfile changed (${cont_sum:-unreadable} -> $host_sum): restarting caddy"
    docker compose restart caddy > "$LOG_DIR/caddy.log" 2>&1 || { tail -10 "$LOG_DIR/caddy.log"; echo "deploy: CADDY RESTART FAILED (docker compose logs caddy)"; exit 1; }
    sleep 3
    cont_sum=$(docker compose exec -T caddy sha256sum /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1 || true)
    if [ "$host_sum" != "$cont_sum" ]; then
      echo "deploy: caddy restarted but still reads another Caddyfile (host $host_sum, container ${cont_sum:-unreadable}) — check docker compose logs caddy"
      exit 1
    fi
    echo "   caddy is running the new Caddyfile"
  fi
fi

DONE=1
echo "deploy: done"
