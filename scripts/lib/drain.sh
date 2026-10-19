# shellcheck shell=bash
# Drain helpers for scripts/deploy.sh, kept apart so that scripts/test/drain.test.sh can run them against a fake `docker`.
# Sourced, not executed. Expects `docker compose` to work from the current directory.

# set_drain true|false: switch the orchestrator's drain mode and say what really happened.
# Returns 0 on HTTP 200, 1 when the route does not exist (an orchestrator that predates it), 2 on anything else
# (no answer, 401, 5xx, the container is not running). The caller decides how loud to be.
set_drain() {
  local want=$1 out status
  out=$(docker compose exec -T orchestrator node -e "fetch('http://127.0.0.1:8080/admin/drain',{method:'POST',headers:{'x-internal-token':process.env.INTERNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({draining:$want})}).then(r=>console.log('HTTP '+r.status)).catch(e=>console.log('ERR '+e.message))" 2>&1 | tail -n 1) || true
  status=$(printf '%s' "$out" | sed -n 's/^HTTP \([0-9][0-9]*\)$/\1/p')
  case "$status" in
    200) echo "   drain=$want: HTTP 200"; return 0 ;;
    404) echo "   drain=$want: HTTP 404 (this orchestrator predates the drain route)"; return 1 ;;
    *)   echo "   drain=$want: NOT CONFIRMED (${out:-no answer from the orchestrator container})"; return 2 ;;
  esac
}

# inflight_count: print the number of sessions that are provisioning or being checked.
# Prints nothing at all when the answer cannot be trusted (docker or the database does not answer): an empty answer is
# "unknown", never "0". Prints 0 when there is nothing to wait for: no db container at all (a stopped one is not "none": its sessions are unknown) or no schema yet (first install).
inflight_count() {
  local ids has
  ids=$(docker compose ps -a -q db 2>/dev/null) || return 0
  if [ -z "$ids" ]; then echo 0; return 0; fi
  has=$(docker compose exec -T db psql -U wom -d wom -tAc "select to_regclass('public.\"TrainingSession\"') is not null" 2>/dev/null | tr -d '[:space:]') || true
  if [ "$has" = f ]; then echo 0; return 0; fi
  [ "$has" = t ] || return 0
  docker compose exec -T db psql -U wom -d wom -tAc "select count(*) from \"TrainingSession\" where status in ('REQUESTED','PROVISIONING','CHECKING')" 2>/dev/null | tr -dc 0-9 || true
}

# running_count: print the number of RUNNING sessions (their terminals are open in somebody's browser). Prints nothing
# when it cannot be read; a restart of the orchestrator drops those terminals, so the deploy says how many it touches.
running_count() {
  local has
  has=$(docker compose exec -T db psql -U wom -d wom -tAc "select to_regclass('public.\"TrainingSession\"') is not null" 2>/dev/null | tr -d '[:space:]') || true
  [ "$has" = t ] || return 0
  docker compose exec -T db psql -U wom -d wom -tAc "select count(*) from \"TrainingSession\" where status = 'RUNNING'" 2>/dev/null | tr -dc 0-9 || true
}

# wait_drained MAX_SEC: poll inflight_count until it is 0. Returns 0 when drained, 1 on timeout.
# Leaves the last answer in $drain_n (empty = the counter could not be read).
wait_drained() {
  local max=$1 waited=0 step=${DRAIN_POLL_SEC:-5}
  drain_n=""
  while :; do
    drain_n=$(inflight_count)
    [ "$drain_n" != 0 ] || return 0
    [ "$waited" -lt "$max" ] || return 1
    if [ -z "$drain_n" ]; then
      echo "   cannot read the session counter (docker or the database does not answer), waiting… (${waited}s of ${max}s)"
    else
      echo "   $drain_n session(s) provisioning/checking, waiting… (${waited}s of ${max}s)"
    fi
    sleep "$step"; waited=$((waited + step))
  done
}
