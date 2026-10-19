#!/usr/bin/env bash
# One Telegram message from the production host: deploy/notify.sh "text".
# TG_BOT_TOKEN and TG_CHAT_ID come from ~/.wom-hostwatch.env (never from the repository). Exits 1 when nobody could be told,
# so a missing token is visible in the journal instead of silently swallowing every alert.
set -u
[ -f "$HOME/.wom-hostwatch.env" ] && . "$HOME/.wom-hostwatch.env"
if [ -z "${TG_BOT_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then
  echo "notify: TG_BOT_TOKEN / TG_CHAT_ID are not set in ~/.wom-hostwatch.env, nobody was told: ${1:-}" >&2
  exit 1
fi
curl -sf -m 10 -o /dev/null "https://api.telegram.org/bot$TG_BOT_TOKEN/sendMessage" \
  --data-urlencode "chat_id=$TG_CHAT_ID" --data-urlencode "text=${1:-}" || { echo "notify: the Telegram call failed" >&2; exit 1; }
