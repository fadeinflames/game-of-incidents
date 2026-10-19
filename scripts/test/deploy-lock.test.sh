#!/usr/bin/env bash
# A second scripts/deploy.sh must refuse at once while another one holds the lock (infra-11).
# Runs a COPY of the script in a scratch tree without .git and .env, so it can never touch the real checkout.
set -u
cd "$(dirname "$0")"
. ./helpers.sh
if ! command -v flock >/dev/null; then skip "flock is not installed here (Linux only)"; finish; fi

mkdir -p "$TMP/tree/scripts/lib"
cp ../deploy.sh "$TMP/tree/scripts/deploy.sh"
cp ../lib/drain.sh "$TMP/tree/scripts/lib/drain.sh"
export WOM_DEPLOY_LOCK="$TMP/deploy.lock"

# a "running deploy": holds the lock for a while
( flock -n 9 && : > "$TMP/holder.ready" && exec sleep 20 ) 9>"$WOM_DEPLOY_LOCK" &
holder=$!
# wait for the holder's own signal: probing the lock file meanwhile would take the lock for a moment and make the holder fail
for _ in $(seq 1 50); do [ -e "$TMP/holder.ready" ] && break; sleep 0.1; done
[ -e "$TMP/holder.ready" ] || { fail "the lock holder did not start"; finish; }

out=$(bash "$TMP/tree/scripts/deploy.sh" 2>&1); rc=$?
assert_eq "second deploy exits with 1" 1 $rc
assert_contains "second deploy says why" "$out" "another deploy is already running"
assert_not_contains "second deploy did not get as far as .env" "$out" "no .env"

kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
out=$(bash "$TMP/tree/scripts/deploy.sh" 2>&1); rc=$?
assert_contains "a free lock lets the deploy start (it stops at the missing .env)" "$out" "no .env"
finish
