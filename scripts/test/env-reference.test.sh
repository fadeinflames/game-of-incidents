#!/usr/bin/env bash
# Every environment variable that the code or the compose files read must be described in .env.example (so that
# a person who installs the platform finds all the settings in one place). Run by scripts/test/run.sh.
set -u
cd "$(dirname "$0")/../.."
fail=0
code=$(git grep -hoE 'process\.env\.[A-Z][A-Z0-9_]+' -- apps/web/src services/orchestrator/src 'packages/*/src' packages/db/prisma/seed.ts | sed 's/^process\.env\.//' | sort -u)
compose=$(git grep -hoE '\$\{[A-Z][A-Z0-9_]+' -- docker-compose.yml deploy/docker-compose.prod.yml | tr -d '${' | sort -u)
documented=$(grep -ohE '^#? ?[A-Z][A-Z0-9_]+=' .env.example | tr -d '# =' | sort -u)
for v in $(printf '%s\n%s\n' "$code" "$compose" | sort -u); do
  if ! printf '%s\n' "$documented" | grep -qx "$v"; then echo "  FAIL $v is read by the code or compose but is not described in .env.example"; fail=$((fail + 1)); fi
done
if [ "$fail" -gt 0 ]; then echo "$fail check(s) FAILED"; exit 1; fi
echo "  ok   every variable read by the code and compose is described in .env.example"
