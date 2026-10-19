# shellcheck shell=bash
# Tiny assertion helpers for scripts/test/*.test.sh. Sourced, not executed.
FAILS=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILS=$((FAILS + 1)); }
skip() { echo "  SKIP $1"; }

assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}
assert_contains() { # name haystack needle
  case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (no '$3' in: $2)" ;; esac
}
assert_not_contains() { # name haystack needle
  case "$2" in *"$3"*) fail "$1 (unexpected '$3' in: $2)" ;; *) pass "$1" ;; esac
}

# succeeds when chmod really changes the mode on this filesystem (it does not on NTFS under Git Bash: mode checks are then skipped)
modes_work() {
  local f="$TMP/.modeprobe"
  : > "$f"; chmod 640 "$f"
  [ "$(stat -c %a "$f")" = 640 ]
}

finish() {
  if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) FAILED"; exit 1; fi
  exit 0
}
