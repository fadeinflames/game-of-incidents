#!/usr/bin/env bash
# scripts/lib/drain.sh against a fake `docker`: an empty answer is "unknown", never "0" (silent-failures-9).
set -u
cd "$(dirname "$0")"
. ./helpers.sh
. ../lib/drain.sh

# fake docker: behaviour comes from FAKE_* variables
docker() {
  case "$*" in
    # `ps -a` lists stopped containers too; plain `ps` only the running ones
    "compose ps -a -q db") printf '%s' "${FAKE_DB_IDS-abc123}"; [ -z "${FAKE_PS_FAIL:-}" ] || return 1 ;;
    "compose ps -q db") [ -n "${FAKE_DB_STOPPED:-}" ] || printf '%s' "${FAKE_DB_IDS-abc123}"; [ -z "${FAKE_PS_FAIL:-}" ] || return 1 ;;
    "compose exec -T db"*)
      [ -z "${FAKE_DB_STOPPED:-}" ] || return 1
      case "$*" in
        *to_regclass*) echo "${FAKE_HAS_SCHEMA-t}" ;;
        *) echo "${FAKE_COUNT-0}" ;;
      esac ;;
    "compose exec -T orchestrator"*) printf '%s\n' "${FAKE_DRAIN_OUT-HTTP 200}" ;;
    *) return 1 ;;
  esac
}
sleep() { :; }

echo "set_drain"
FAKE_DRAIN_OUT="HTTP 200" set_drain true >/dev/null; assert_eq "HTTP 200 is success" 0 $?
FAKE_DRAIN_OUT="HTTP 404" set_drain true >/dev/null; assert_eq "HTTP 404 means an old orchestrator (rc 1)" 1 $?
FAKE_DRAIN_OUT="HTTP 401" set_drain true >/dev/null; assert_eq "HTTP 401 is a failure (rc 2)" 2 $?
FAKE_DRAIN_OUT="ERR fetch failed" set_drain true >/dev/null; assert_eq "a network error is a failure (rc 2)" 2 $?
FAKE_DRAIN_OUT="" set_drain false >/dev/null; assert_eq "no answer at all is a failure (rc 2)" 2 $?
out=$(FAKE_DRAIN_OUT="HTTP 500" set_drain true); assert_contains "the failure is printed" "$out" "NOT CONFIRMED"

echo "inflight_count"
assert_eq "counts sessions" 3 "$(FAKE_COUNT=3 inflight_count)"
assert_eq "zero is zero" 0 "$(FAKE_COUNT=0 inflight_count)"
assert_eq "an empty psql answer is unknown, not 0" "" "$(FAKE_COUNT="" inflight_count)"
assert_eq "an unreadable schema probe is unknown, not 0" "" "$(FAKE_HAS_SCHEMA="" inflight_count)"
assert_eq "docker that fails is unknown" "" "$(FAKE_PS_FAIL=1 FAKE_DB_IDS="" inflight_count)"
assert_eq "a stopped db container is unknown, not 0" "" "$(FAKE_DB_STOPPED=1 inflight_count)"
assert_eq "no db container yet (first install): nothing to wait for" 0 "$(FAKE_DB_IDS="" inflight_count)"
assert_eq "no schema yet (first install): nothing to wait for" 0 "$(FAKE_HAS_SCHEMA=f inflight_count)"

echo "running_count"
assert_eq "counts RUNNING sessions" 4 "$(FAKE_COUNT=4 running_count)"
assert_eq "an empty psql answer is unknown" "" "$(FAKE_COUNT="" running_count)"
assert_eq "no schema yet: unknown, nothing to say" "" "$(FAKE_HAS_SCHEMA=f running_count)"
assert_eq "a stopped db container is unknown" "" "$(FAKE_DB_STOPPED=1 running_count)"

echo "wait_drained"
FAKE_COUNT="" wait_drained 10 >/dev/null; rc=$?
assert_eq "a counter that never answers is NOT drained" 1 $rc
assert_eq "...and the unknown stays empty" "" "$drain_n"
FAKE_COUNT=2 wait_drained 10 >/dev/null; rc=$?
assert_eq "sessions that never finish time out" 1 $rc
assert_eq "...and the last count is kept" 2 "$drain_n"
FAKE_COUNT=0 wait_drained 0 >/dev/null; assert_eq "nothing in flight: drained at once" 0 $?
FAKE_COUNT=1 wait_drained 0 >/dev/null; assert_eq "FORCE=1 (max 0) does not wait" 1 $?
# inflight_count runs in a subshell, so its call counter lives in a file
echo 0 > "$TMP/calls"
inflight_count() { local c; c=$(( $(cat "$TMP/calls") + 1 )); echo "$c" > "$TMP/calls"; if [ "$c" -lt 3 ]; then echo 1; else echo 0; fi; }
wait_drained 100 >/dev/null; assert_eq "drains once the sessions finish" 0 $?
finish
