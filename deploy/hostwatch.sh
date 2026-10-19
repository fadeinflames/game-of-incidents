#!/usr/bin/env bash
# Local watchdog for the production host, started by deploy/wom-hostwatch.timer every 5 minutes. The external probe
# (healthcheck.sh on another machine) sees only HTTP answers; this one sees the machine: disk, load, certificate, backups,
# the docker daemon, the platform containers, the egress guard and leaked kind nodes.
# Sends a Telegram message when the set of problems changes (a new one, or all cleared) and prints one status line per run.
# Config in ~/.wom-hostwatch.env: TG_BOT_TOKEN and TG_CHAT_ID are REQUIRED; thresholds are optional:
#   HOST_DISK_PCT=85  DISK_PATHS="/ /srv/docker /srv/backups /srv/pgdata"  LOAD_MAX=<2 x cores>  CERT_DAYS=14
#   BACKUP_DIR=/srv/backups  BACKUP_MAX_AGE_MIN=1560  KIND_NODES_MAX=24
# Exit codes: 0 all clear, 2 a problem is present (the unit treats 2 as success), 3 no Telegram credentials.
set -u
cd "$(dirname "$0")/.."
export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
[ -f "$HOME/.wom-hostwatch.env" ] && . "$HOME/.wom-hostwatch.env"
if [ -z "${TG_BOT_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then
  echo "hostwatch: TG_BOT_TOKEN / TG_CHAT_ID are not set in ~/.wom-hostwatch.env: alerts would go nowhere" >&2
  exit 3
fi
STATE=${STATE_FILE:-$HOME/.wom-hostwatch.state}
HOST_DISK_PCT=${HOST_DISK_PCT:-85}
CERT_DAYS=${CERT_DAYS:-14}
BACKUP_DIR=${BACKUP_DIR:-/srv/backups}
BACKUP_MAX_AGE_MIN=${BACKUP_MAX_AGE_MIN:-1560}
KIND_NODES_MAX=${KIND_NODES_MAX:-24}
LOAD_MAX=${LOAD_MAX:-$(( $(nproc) * 2 ))}

kinds=""; text=""
add() { kinds="$kinds $1"; text="$text
- $2"; }

# disk: one line per distinct filesystem (the sparse docker image, the root, the backups and the database may share or not).
# The database directory is checked only when it exists: /srv/pgdata, or the absolute PGDATA_MOUNT of .env (a named volume
# lives under the docker data-root, which is covered already). DISK_PATHS in ~/.wom-hostwatch.env replaces the default list.
pgdata=$(grep -E '^PGDATA_MOUNT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\"' ")
case "$pgdata" in /*) ;; *) pgdata=/srv/pgdata ;; esac
seen=""
for p in ${DISK_PATHS:-/ /srv/docker /srv/backups $pgdata}; do
  [ -d "$p" ] || continue
  read -r dev pct mnt < <(df -P "$p" | awk 'NR==2 {gsub("%", "", $5); print $1, $5, $6}')
  case " $seen " in *" $dev "*) continue ;; esac
  seen="$seen $dev"
  if [ "${pct:-0}" -ge "$HOST_DISK_PCT" ]; then add "disk:$mnt" "disk $mnt is ${pct}% full (alert at ${HOST_DISK_PCT}%)"; fi
done

load=$(cut -d' ' -f2 /proc/loadavg)
if awk -v l="$load" -v m="$LOAD_MAX" 'BEGIN { exit !(l > m) }'; then add load "load average (5 min) is $load, above $LOAD_MAX"; fi

if timeout 20 docker info >/dev/null 2>&1; then
  for c in wom_db wom_orchestrator wom_web wom_caddy; do
    [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ] || add "down:$c" "container $c is not running"
  done
  guard=$(docker inspect -f '{{.State.Health.Status}}' wom_egress_guard 2>/dev/null || true)
  [ "$guard" = "healthy" ] || add guard "egress guard is ${guard:-missing}: Kubernetes sessions are refused and the rules may be missing"
  nodes=$(docker ps -q --filter label=io.x-k8s.kind.cluster | wc -l)
  if [ "$nodes" -gt "$KIND_NODES_MAX" ]; then add kind "$nodes kind nodes are running (limit $KIND_NODES_MAX): clusters are leaking"; fi
else
  add docker "the docker daemon does not answer"
fi

if [ -z "$(find "$BACKUP_DIR" -maxdepth 1 -name 'wom-*.sql.gz' -mmin "-$BACKUP_MAX_AGE_MIN" 2>/dev/null | head -n 1)" ]; then
  add backup "no database dump newer than $((BACKUP_MAX_AGE_MIN / 60)) h in $BACKUP_DIR"
fi

# the certificate that Caddy really serves, asked on this host (no hairpin through the public address)
domain=$(grep -E '^WOM_DOMAIN=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "\"' ")
if [ -n "$domain" ]; then
  end=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$domain" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$end" ]; then
    add cert "cannot read the TLS certificate of $domain from 127.0.0.1:443"
  else
    days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
    if [ "$days" -lt "$CERT_DAYS" ]; then add cert "the certificate of $domain expires in $days day(s)"; fi
  fi
fi

# the state keeps only the kinds of problem, so a disk that moves from 86 to 87 % does not notify again
prev=$(cat "$STATE" 2>/dev/null || true)
if [ "$kinds" != "$prev" ]; then
  if [ -n "$kinds" ]; then msg="🟠 Game of Incidents host $(hostname) has problems:$text"; else msg="🟢 Game of Incidents host $(hostname): all clear"; fi
  # a failed send keeps the old state, so the next run tries again
  # through bash: works whatever the file mode is (a checkout can lose the exec bit)
  bash "$(dirname "$0")/notify.sh" "$msg" && printf '%s' "$kinds" > "$STATE"
fi
echo "$(date -Is) hostwatch load=$load problems=${kinds# }"
[ -z "$kinds" ] || exit 2
exit 0
