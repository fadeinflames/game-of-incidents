#!/usr/bin/env bash
# Runs every scripts/test/*.test.sh (tests of the operations scripts against a fake `docker`; no Docker, no database).
# Exits non-zero when any of them fails. Called by scripts/verify.sh, or by hand: bash scripts/test/run.sh
set -u
cd "$(dirname "$0")"
failed=0
for t in ./*.test.sh; do
  echo "== $t"
  bash "$t" || failed=$((failed + 1))
done
if [ "$failed" -gt 0 ]; then echo "scripts/test: $failed file(s) FAILED"; exit 1; fi
echo "scripts/test: all passed"
