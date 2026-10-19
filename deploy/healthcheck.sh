#!/usr/bin/env bash
# External liveness check, meant for cron on another machine (a different machine from the server): notifies on DOWN and on RECOVERY,
# and separately when a warning appears or clears: disk usage of the sandbox data-root, a stale egress guard, a stale backup.
#   */5 * * * * /path/to/deploy/healthcheck.sh https://game.example.com
# Telegram alerts need TG_BOT_TOKEN and TG_CHAT_ID (e.g. in ~/.wom-healthcheck.env); without them the script complains on stderr.
# Optional: DISK_ALERT_PCT (default 85); BACKUP_MIRROR_DIR = local copy of /srv/backups pulled by rsync, warns when the
# newest dump there is older than 26 h (rsync -a keeps the mtime of the server).
set -u
BASE=${1:?base url}
STATE=${STATE_FILE:-$HOME/.wom-healthcheck.state}
[ -f "$HOME/.wom-healthcheck.env" ] && . "$HOME/.wom-healthcheck.env"
DISK_ALERT_PCT=${DISK_ALERT_PCT:-85}
# without Telegram credentials every alert below goes nowhere: say so on stderr (cron mails it) instead of staying silent
if [ -z "${TG_BOT_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then echo "healthcheck: TG_BOT_TOKEN / TG_CHAT_ID are not set (~/.wom-healthcheck.env): alerts go nowhere" >&2; fi

resp=$(curl -s -m 10 -w '\n%{http_code}' "$BASE/api/health" || true)
web=${resp##*$'\n'}
body=${resp%$'\n'*}
ok=1; [ "$web" = "200" ] || ok=0
# a 200 whose body says ok:false (the web relays the orchestrator's own verdict) is an outage as well
if printf '%s' "$body" | grep -qE '"ok": ?false'; then ok=0; fi
# reasons, for the message: failed checks and the degradation list of the orchestrator ("degraded":["docker","reconciler",...])
reasons=""
printf '%s' "$body" | grep -qE '"db": ?false' && reasons="$reasons db"
printf '%s' "$body" | grep -qE '"orchestrator": ?false' && reasons="$reasons orchestrator"
degraded=$(printf '%s' "$body" | grep -oE '"degraded": ?\[[^]]*\]' | head -n 1 | sed 's/^"degraded": *\[//; s/\]$//; s/[" ]//g')
[ -z "$degraded" ] || reasons="$reasons degraded:$degraded"
prev=$(cat "$STATE" 2>/dev/null || echo 1)
# succeeds only when Telegram accepted the message (-f: an HTTP error such as 401/429 is a failure, not a delivered alert)
notify() {
  [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] || return 1
  curl -sf -m 10 -o /dev/null "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage" --data-urlencode "chat_id=$TG_CHAT_ID" --data-urlencode "text=$1"
}
# The state changes only after the alert was delivered: a failed send leaves the old state, so the next run sends it again.
if [ "$ok" = 0 ] && [ "$prev" = 1 ]; then
  notify "🔴 Game of Incidents DOWN: $BASE/api/health -> $web${reasons:+ (${reasons# })}" && echo "$ok" > "$STATE"
elif [ "$ok" = 1 ] && [ "$prev" = 0 ]; then
  notify "🟢 Game of Incidents recovered: $BASE" && echo "$ok" > "$STATE"
else
  echo "$ok" > "$STATE"
fi

# Warnings are judged only on a healthy answer: a 503 body has no disk/egress values and would read as "cleared".
# No jq on the monitoring host: checks.disk is a whole percent or null, checks.egress is "ok" | "stale" | "off".
disk=""; egress=""; warn=""; text=""
if [ "$ok" = 1 ]; then
  disk=$(printf '%s' "$body" | grep -oE '"disk":(\{"usedPct":)?[0-9]+' | head -n 1 | sed 's/.*[^0-9]//')
  egress=$(printf '%s' "$body" | grep -oE '"egress":"[a-z]+"' | head -n 1 | sed 's/.*:"//; s/"$//')
  if [ -n "$disk" ] && [ "$disk" -ge "$DISK_ALERT_PCT" ]; then warn="$warn disk"; text="$text disk ${disk}% used (alert at ${DISK_ALERT_PCT}%);"; fi
  if [ "$egress" = "stale" ]; then warn="$warn egress"; text="$text egress guard is stale, Kubernetes sessions are refused;"; fi
  if [ -n "$degraded" ]; then warn="$warn degraded:$degraded"; text="$text the orchestrator reports degradation ($degraded);"; fi
  if [ -n "${BACKUP_MIRROR_DIR:-}" ] && [ -z "$(find "$BACKUP_MIRROR_DIR" -name 'wom-*.sql.gz' -mmin -1560 2>/dev/null | head -n 1)" ]; then
    warn="$warn backup"; text="$text no database dump newer than 26 h in $BACKUP_MIRROR_DIR;"
  fi
  # the state keeps only the kinds of warning, so a disk that moves from 86 to 87 % does not notify again
  prevwarn=$(cat "$STATE.warn" 2>/dev/null || true)
  # written, like the up/down state, only after the message was delivered
  if [ "$warn" != "$prevwarn" ]; then
    if [ -n "$warn" ]; then msg="🟠 Game of Incidents warning ($BASE):$text"; else msg="🟢 Game of Incidents warnings cleared: $BASE"; fi
    notify "$msg" && printf '%s' "$warn" > "$STATE.warn"
  fi
fi
kinds=${warn# }
echo "$(date -Is) health web=$web ok=$ok disk=${disk:-?} egress=${egress:-?} warn=${kinds:-none}"
[ "$ok" = 1 ] || exit 1
[ -z "$warn" ] || exit 2
exit 0
