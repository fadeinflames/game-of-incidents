#!/usr/bin/env bash
# Game of Incidents: application setup on a prepared host. Run as the service user (wom), from the repository directory
# (or by path: ~/wom-platform/scripts/provision/app-setup.sh). The host itself (docker, user, volumes, firewall) is prepared
# by scripts/provision/host-setup.sh; scripts/provision/provision.sh runs both from the admin's machine.
#
# Usage:
#   scripts/provision/app-setup.sh --domain D [--registration open|closed] [--admin-user NAME] [--admin-email EMAIL]
#       [--contact-url URL] [--dump FILE.sql.gz] [--smoke none|linux|full] [--hostwatch] [--dry-run]
#
# What it does, in order (every step can be repeated: a second run changes nothing that is already right):
#   1. checks (not root, docker works for this user, systemd --user, node, the repository files);
#   2. .env: created ONLY when it does not exist (random secrets, mode 600); an existing .env gets only the managed keys
#      that this run names, its secrets are never read back or changed. The administrator's password is also kept in
#      ~/.wom-admin-password (mode 600) and is never printed;
#   3. systemd --user units: wom.service, wom-backup.service/.timer (+ wom-hostwatch.* with --hostwatch);
#   4. --dump: restore of a database dump BEFORE the first login (only into an empty database);
#   5. scripts/deploy.sh (images, scenarios, migrations, seed, stack); 6. wom.service started; 7. health inside the compose
#      network and from outside (https://DOMAIN/api/health, waits for the certificate); 8. smoke test of scenarios;
#   9. ADMIN_PASSWORD removed from .env once the administrator exists (runbook §5); 10. report ~/install-report.txt.
#
# Exit codes: 0 done; 1 a step failed; 2 bad arguments or a failed check (nothing was changed); 4 the platform is up, but
# something needs attention (https://DOMAIN does not answer from the host yet, the smoke test failed, ...): see the report.
#
# Test knobs (environment): WOM_PGDATA_DIR (/srv/pgdata), WOM_HEALTH_WAIT_SEC (300), WOM_HEALTH_POLL_SEC (5),
# WOM_DOCKER_WAIT_SEC (30), WOM_SMOKE_TIMEOUT_SEC (1800).
#
# The functions can be sourced and tested: main runs only when the file is executed.

APP_TITLE="Game of Incidents"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
ENV_FILE="$REPO_DIR/.env"
UNIT_DIR_REL=".config/systemd/user"
PGDATA_DIR=${WOM_PGDATA_DIR:-/srv/pgdata}
COMPOSE_OVERLAY="docker-compose.yml:deploy/docker-compose.prod.yml"

# ---- arguments (filled by parse_args) -------------------------------------------------------------------------------
DOMAIN=""; REGISTRATION=""; ADMIN_USER=""; ADMIN_EMAIL=""; CONTACT_URL=""; DUMP=""; SMOKE="linux"; HOSTWATCH=0; DRY_RUN=0
TRUSTED_PROXY=""   # --trusted-proxy CIDR: a TCP proxy in front that sends PROXY protocol (WOM_TRUSTED_PROXY)
ASSUME_YES=0   # --yes: confirms a change of the domain of an already configured platform

# ---- run state ------------------------------------------------------------------------------------------------------
RESULTS=(); ATTN=(); NEXT=(); FATALS=()
REPORT_ENABLED=0
ENV_CREATED=0
DEPLOYED=0
HEALTH_JSON=""
PHASE="проверки"

say()  { printf '%s\n' "$*"; }
step() { PHASE=$*; printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '   предупреждение: %s\n' "$*" >&2; }
plan() { printf '   [план] %s\n' "$*"; }
die()  { printf 'app-setup: ОШИБКА: %s\n' "$*" >&2; exit 1; }
ok()   { RESULTS+=("ok   $*"); note "готово: $*"; }
attn() { RESULTS+=("ВНИМАНИЕ  $*"); ATTN+=("$*"); printf '   ВНИМАНИЕ: %s\n' "$*" >&2; }

usage() {
  cat <<EOF
Использование: scripts/provision/app-setup.sh --domain ДОМЕН [параметры]

Настраивает приложение $APP_TITLE на подготовленном хосте (запускай от пользователя wom, не от root).

  --domain D            публичное имя сайта, например game.example.com (обязателен)
  --registration MODE   open (по умолчанию) или closed: открыта ли регистрация
  --admin-user NAME     имя администратора (по умолчанию admin)
  --admin-email EMAIL   почта администратора (по умолчанию admin@ДОМЕН)
  --contact-url URL     ссылка «Написать нам»: https://t.me/<чат> или mailto:<адрес>
  --trusted-proxy CIDR  адрес TCP-прокси перед сервером, который передаёт адрес клиента PROXY protocol (например 10.10.10.2/32)
  --dump FILE.sql.gz    восстановить дамп базы до первого входа (только в пустую базу)
  --smoke MODE          none | linux (по умолчанию, один сценарий) | full (ещё кластерный сценарий)
  --hostwatch           установить локальный сторож хоста (нужен ~/.wom-hostwatch.env с Telegram)
  --dry-run             ничего не менять, только напечатать план
  --yes                 подтвердить смену домена уже настроенной платформы (по умолчанию скрипт откажется)
  -h, --help            эта справка

Коды выхода: 0 готово; 1 шаг не удался; 2 неверные аргументы или проверка не пройдена; 4 платформа работает,
но нужно внимание (см. ~/install-report.txt).
EOF
}

# ---- argument parsing and validation --------------------------------------------------------------------------------
# prints a message and returns 2 on any problem; the caller exits
parse_args() {
  local args=() a
  # --name=value -> --name value
  for a in "$@"; do
    case "$a" in
      --*=*) args+=("${a%%=*}" "${a#*=}") ;;
      *) args+=("$a") ;;
    esac
  done
  set -- ${args[@]+"${args[@]}"}
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --hostwatch) HOSTWATCH=1; shift; continue ;;
      --dry-run) DRY_RUN=1; shift; continue ;;
      --yes) ASSUME_YES=1; shift; continue ;;
      --domain|--registration|--admin-user|--admin-email|--contact-url|--trusted-proxy|--dump|--smoke)
        if [ $# -lt 2 ]; then echo "app-setup: у параметра $1 нет значения (справка: --help)" >&2; return 2; fi
        case "$1" in
          --trusted-proxy) TRUSTED_PROXY=$2 ;;
          --domain) DOMAIN=$2 ;;
          --registration) REGISTRATION=$2 ;;
          --admin-user) ADMIN_USER=$2 ;;
          --admin-email) ADMIN_EMAIL=$2 ;;
          --contact-url) CONTACT_URL=$2 ;;
          --dump) DUMP=$2 ;;
          --smoke) SMOKE=$2 ;;
        esac
        shift 2 ;;
      *) echo "app-setup: неизвестный параметр '$1' (справка: --help)" >&2; return 2 ;;
    esac
  done
  return 0
}

valid_domain() {
  local d=$1
  [ "${#d}" -le 253 ] || return 1
  [[ $d =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]
}
# no domain: the site is served by its IPv4 address with Caddy's own (self-signed) certificate
is_ipv4() {
  local o
  [[ $1 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for o in ${1//./ }; do [ "$((10#$o))" -le 255 ] || return 1; done
}
valid_site() { is_ipv4 "$1" || valid_domain "$1"; }
valid_username() { [[ $1 =~ ^[A-Za-z0-9._-]{3,32}$ ]]; }
valid_email() { [ "${#1}" -le 254 ] && [[ $1 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
# a value goes into .env and into the page footer: no spaces, quotes, $, backticks, backslashes or # (they would be
# re-interpreted by docker compose when it reads .env)
valid_contact_url() {
  case "$1" in
    *[[:space:]\"\'\`\$\\#]*) return 1 ;;
    https://?*|mailto:?*) return 0 ;;
  esac
  return 1
}

validate_args() {
  local bad=0
  complain() { echo "app-setup: $*" >&2; bad=1; }
  if [ -z "$DOMAIN" ]; then
    complain "не указан --domain (например --domain game.example.com)"
  else
    DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
    valid_site "$DOMAIN" || complain "--domain '$DOMAIN' не похож на имя сайта (нужно имя вида game.example.com или IPv4-адрес, без https:// и без порта)"
  fi
  case "$REGISTRATION" in ""|open|closed) ;; *) complain "--registration: open или closed, а не '$REGISTRATION'" ;; esac
  if [ -n "$TRUSTED_PROXY" ] && ! [[ $TRUSTED_PROXY =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then
    complain "--trusted-proxy '$TRUSTED_PROXY': нужен IPv4 с маской, например 10.10.10.2/32"
  fi
  case "$SMOKE" in none|linux|full) ;; *) complain "--smoke: none, linux или full, а не '$SMOKE'" ;; esac
  if [ -n "$ADMIN_USER" ]; then
    valid_username "$ADMIN_USER" || complain "--admin-user: от 3 до 32 символов, латинские буквы, цифры, точка, дефис, подчёркивание"
    ADMIN_USER=$(printf '%s' "$ADMIN_USER" | tr 'A-Z' 'a-z')
  fi
  if [ -n "$ADMIN_EMAIL" ]; then
    valid_email "$ADMIN_EMAIL" || complain "--admin-email '$ADMIN_EMAIL' не похож на адрес почты"
  fi
  if [ -n "$CONTACT_URL" ]; then
    valid_contact_url "$CONTACT_URL" || complain "--contact-url: https://t.me/<чат> или mailto:<адрес>, без пробелов, кавычек и знаков \$ \\ #"
  fi
  if [ -n "$DUMP" ]; then
    if [ ! -f "$DUMP" ] || [ ! -r "$DUMP" ]; then
      complain "--dump: файл '$DUMP' не найден или не читается"
    elif ! gzip -t "$DUMP" 2>/dev/null; then
      complain "--dump: '$DUMP' не проходит gzip -t (нужен дамп pg_dump | gzip, *.sql.gz)"
    else
      DUMP=$(cd "$(dirname "$DUMP")" && printf '%s/%s' "$(pwd)" "$(basename "$DUMP")")
    fi
  fi
  # systemd units are rendered with this path (sed): keep it free of anything that would need escaping
  case "$REPO_DIR" in *[[:space:]\|\&\\]*) complain "путь к репозиторию '$REPO_DIR' содержит пробел или знак | & \\: перенеси его, например в ~/wom-platform" ;; esac
  [ "$bad" = 0 ] || return 2
  return 0
}

# ---- environment of the run -----------------------------------------------------------------------------------------
init_runtime() {
  local uid
  uid=$(id -u)
  # a login shell has XDG_RUNTIME_DIR; a bare `ssh host cmd` may not
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$uid" ]; then
    export XDG_RUNTIME_DIR="/run/user/$uid"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    export DOCKER_HOST=${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}
  fi
  UNIT_DIR="$HOME/$UNIT_DIR_REL"
  ADMIN_PW_FILE="$HOME/.wom-admin-password"
  REPORT_FILE="$HOME/install-report.txt"
}

dc() { docker compose "$@"; }
sctl() { systemctl --user "$@"; }
repeat_sleep() { sleep "$1"; }

# ---- .env helpers (secrets never go through argv) -------------------------------------------------------------------
env_get() { # KEY -> value without surrounding quotes
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true)
  printf '%s' "$v"
}
env_has() { grep -qE "^$1=" "$ENV_FILE" 2>/dev/null; }
# env_set KEY VALUE: replaces the first KEY= line (and drops repeats) or appends it. The value reaches awk through the
# environment, so no quoting or backslash rule of awk -v applies and nothing appears on a command line.
env_set() {
  local key=$1 val=$2 tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX") || return 1
  if KEY=$key VAL=$val awk '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
      index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$tmp"; then
    mv "$tmp" "$ENV_FILE"
  else
    rm -f "$tmp"; return 1
  fi
}

rand_hex() { # BYTES -> 2*BYTES hex characters, from openssl or /dev/urandom
  local out=""
  if command -v openssl >/dev/null 2>&1; then out=$(openssl rand -hex "$1" 2>/dev/null) || out=""; fi
  if [ -z "$out" ]; then out=$(od -An -N"$1" -tx1 /dev/urandom 2>/dev/null | tr -d ' \n') || out=""; fi
  [ "${#out}" -eq $(($1 * 2)) ] || return 1
  printf '%s' "$out"
}

detect_netns_file() {
  local f="${XDG_RUNTIME_DIR:-}/dockerd-rootless/netns"
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -e "$f" ]; then printf '%s' "$f"; fi
}

pgdata_in_use() { # the directory already holds a database (initialised by the container: owned by a subuid)
  local d=$PGDATA_DIR owner
  [ -d "$d" ] || return 1
  owner=$(stat -c %u "$d" 2>/dev/null || echo "")
  [ -z "$owner" ] || [ "$owner" = "$(id -u)" ] || return 0
  [ -z "$(ls -A "$d" 2>/dev/null)" ] || return 0
  return 1
}
db_volume_exists() { docker volume ls -q 2>/dev/null | grep -qE '(^|_)wom_db_data$'; }

# ---- 1. checks ------------------------------------------------------------------------------------------------------
fatal() { FATALS+=("$*"); }

preflight() {
  FATALS=()
  local c f uid major tries i
  uid=$(id -u)
  [ "$uid" != 0 ] || fatal "скрипт запущен от root. Запускай от сервисного пользователя wom (после scripts/provision/host-setup.sh)"
  for f in docker-compose.yml deploy/docker-compose.prod.yml scripts/deploy.sh deploy/wom.service deploy/wom-backup.service deploy/wom-backup.timer 'deploy/wom-failed@.service'; do
    [ -f "$REPO_DIR/$f" ] || fatal "в репозитории нет файла $f (каталог $REPO_DIR): дерево доставлено не полностью"
  done
  [ -e "$REPO_DIR/.git" ] || fatal "в $REPO_DIR нет .git: deploy.sh работает только в git-репозитории (git init и коммит; provision.sh делает это сам)"
  for c in docker git curl flock systemctl node npm gzip gunzip awk sed grep mktemp; do
    command -v "$c" >/dev/null 2>&1 || fatal "не найдена команда '$c'. Её ставит host-setup.sh (пакеты, Docker, Node.js 22); запусти его или поставь вручную"
  done
  if command -v node >/dev/null 2>&1; then
    major=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
    if [ -z "$major" ] || [ "$major" -lt 22 ]; then fatal "нужен Node.js 22 или новее (сейчас: $(node --version 2>/dev/null || echo 'нет ответа')): он нужен команде wom и сидам на хосте"; fi
  fi
  # a platform that is already configured for another name: a changed WOM_DOMAIN makes Caddy ask for a new certificate and
  # breaks every old link, so it needs an explicit --yes (this also stops a run against the wrong server)
  if [ -f "$ENV_FILE" ] && [ "$ASSUME_YES" != 1 ]; then
    local cur_domain
    cur_domain=$(env_get WOM_DOMAIN | tr 'A-Z' 'a-z')
    if [ -n "$cur_domain" ] && [ "$cur_domain" != "$DOMAIN" ]; then
      fatal "в $ENV_FILE уже задан домен $cur_domain, а ты указал $DOMAIN. Смена домена на настроенной платформе ломает старые ссылки и требует нового сертификата: если это сделано намеренно, добавь --yes; если нет, ты запускаешь скрипт не на том сервере"
    fi
  fi
  if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "${XDG_RUNTIME_DIR:-/nonexistent}" ]; then
    fatal "нет XDG_RUNTIME_DIR (/run/user/$uid): зайди по ssh как wom (не через su), проверь 'loginctl enable-linger wom', или запусти с XDG_RUNTIME_DIR=/run/user/$uid"
  fi
  if command -v docker >/dev/null 2>&1; then
    # the rootless daemon may still be starting right after host-setup
    tries=$(( ${WOM_DOCKER_WAIT_SEC:-30} / 3 )); [ "$tries" -ge 1 ] || tries=1
    [ "$DRY_RUN" != 1 ] || tries=1
    i=0
    until docker info >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -ge "$tries" ]; then
        fatal "docker не отвечает у пользователя $(id -un) (DOCKER_HOST=${DOCKER_HOST:-не задан}). Проверь: systemctl --user status docker; journalctl --user -u docker -n 30"
        break
      fi
      repeat_sleep 3
    done
    if [ "$i" -lt "$tries" ]; then
      case "$(docker info --format '{{.SecurityOptions}}' 2>/dev/null)" in
        *rootless*) ;;
        *) warn "docker работает не в rootless-режиме: платформа рассчитана на rootless-демон (docs/runbook-prod-install.md §3)" ;;
      esac
      docker compose version >/dev/null 2>&1 || fatal "нет плагина 'docker compose' (пакет docker-compose-plugin)"
    fi
  fi
  if command -v systemctl >/dev/null 2>&1 && ! sctl show-environment >/dev/null 2>&1; then
    fatal "systemd --user недоступен (нет сессии пользователя): проверь XDG_RUNTIME_DIR и 'loginctl enable-linger $(id -un)'"
  fi
  if command -v loginctl >/dev/null 2>&1; then
    [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] \
      || warn "linger выключен у $(id -un): после перезагрузки сервера платформа не поднимется сама (root: loginctl enable-linger $(id -un))"
  fi
  local ctl="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers"
  if [ -r "$ctl" ]; then
    for c in cpu memory pids; do
      grep -qw "$c" "$ctl" || warn "cgroup-контроллер '$c' не делегирован пользователю: лимиты памяти и процессов не будут действовать (runbook §3)"
    done
  fi
  return 0
}

report_preflight() {
  if [ "${#FATALS[@]}" -eq 0 ]; then ok "проверки окружения"; return 0; fi
  local m
  for m in "${FATALS[@]}"; do printf '   НЕ ПРОЙДЕНО: %s\n' "$m" >&2; done
  if [ "$DRY_RUN" = 1 ]; then
    warn "в режиме --dry-run это не останавливает вывод плана, но настоящий запуск остановится"
    return 0
  fi
  return 2
}

# ---- 2. .env --------------------------------------------------------------------------------------------------------
# Capacity of the sessions from the size of this machine, written once into a new .env (an existing .env is never resized:
# the owner may have tuned it). The production overlay defaults (20 sessions, 6 clusters, kind nodes of 4 GB) assume 8 CPU
# and 32 GB; a smaller host would accept sessions it cannot start. Prints the lines for .env.
host_cpus() { nproc 2>/dev/null || echo 1; }
host_mem_mb() { awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0; }
capacity_profile() {
  local cpus mem
  cpus=$(host_cpus); mem=$(host_mem_mb)
  if [ "$mem" -lt 15000 ] || [ "$cpus" -lt 4 ]; then
    printf '%s\n' "# capacity profile: small host ($cpus CPU, $mem MB): few sessions, one cluster at a time, slower start" \
      MAX_SESSIONS_GLOBAL=4 MAX_K8S_SESSIONS=1 MAX_K8S_PROVISIONING=1 KIND_NODE_MEMORY_MB=2048 KIND_NODE_CPUS=1 \
      PROVISIONING_TIMEOUT_MS=900000 BREAK_TIMEOUT_MS=420000 WOM_IMAGE_CACHE_MAX_MB=2048
  elif [ "$mem" -lt 30000 ] || [ "$cpus" -lt 8 ]; then
    printf '%s\n' "# capacity profile: medium host ($cpus CPU, $mem MB)" \
      MAX_SESSIONS_GLOBAL=10 MAX_K8S_SESSIONS=3 MAX_K8S_PROVISIONING=1 KIND_NODE_MEMORY_MB=3072 KIND_NODE_CPUS=2 \
      PROVISIONING_TIMEOUT_MS=600000 WOM_IMAGE_CACHE_MAX_MB=4096
  fi
  return 0
}

# the host port for the database (migrations and seed run on the host): 5433, or the next free one when something else holds it
port_in_use() { # PORT
  command -v ss >/dev/null 2>&1 || return 1
  [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
}
pick_db_port() {
  local p=5433
  while port_in_use "$p" && [ "$p" -lt 5460 ]; do p=$((p + 1)); done
  printf '%s' "$p"
}

create_env() {
  local pg_pass token admin_pass netns sock admin_user admin_email reg contact db_port pgdata_line=""
  pg_pass=$(rand_hex 24) && token=$(rand_hex 32) && admin_pass=$(rand_hex 16) \
    || die "не удалось получить случайные байты (openssl или /dev/urandom): .env не создан"
  netns=$(detect_netns_file)
  db_port=$(pick_db_port)
  [ "$db_port" = 5433 ] || note "порт 5433 на этом хосте занят: база будет опубликована на 127.0.0.1:$db_port (DB_HOST_PORT в .env)"
  sock="${XDG_RUNTIME_DIR}/docker.sock"
  admin_user=${ADMIN_USER:-admin}
  if is_ipv4 "$DOMAIN"; then admin_email=${ADMIN_EMAIL:-admin@game.local}; else admin_email=${ADMIN_EMAIL:-admin@$DOMAIN}; fi
  case "${REGISTRATION:-open}" in closed) reg=false ;; *) reg=true ;; esac
  contact=$CONTACT_URL

  if pgdata_in_use; then
    die "$PGDATA_DIR уже содержит базу (создана раньше), а файла .env нет. Новый POSTGRES_PASSWORD не подойдёт к этой базе. Верни прежний .env (копия .env.age от бэкапа или менеджер паролей) в $ENV_FILE, либо, если данные не нужны, очисти каталог от root и запусти снова"
  fi
  if db_volume_exists; then
    # the image keeps the password of the first initialisation: a new POSTGRES_PASSWORD would not fit the data in the volume
    die "в Docker уже есть том базы *_wom_db_data, а файла .env нет. Новый POSTGRES_PASSWORD не подойдёт к этой базе. Верни прежний .env (копия .env.age от бэкапа или менеджер паролей) в $ENV_FILE; если данные не нужны, сначала удали том (docker compose down; docker volume rm <проект>_wom_db_data) и запусти снова"
  fi
  mkdir -p "$PGDATA_DIR" 2>/dev/null || die "не могу создать $PGDATA_DIR (его создаёт host-setup.sh от root): запусти host-setup.sh"
  [ -w "$PGDATA_DIR" ] || die "$PGDATA_DIR недоступен для записи пользователю $(id -un): запусти host-setup.sh"
  pgdata_line="PGDATA_MOUNT=$PGDATA_DIR"

  (
    umask 077
    {
      cat <<EOF
# $APP_TITLE: production settings written by scripts/provision/app-setup.sh. Mode 600; do not commit, keep a copy in a password manager.
# A re-run of app-setup.sh changes only the keys named on its command line and never touches the secrets.
COMPOSE_FILE=$COMPOSE_OVERLAY
WOM_DOMAIN=$DOMAIN
REGISTRATION_ENABLED=$reg
CONTACT_URL=$contact
DOCKER_SOCKET_PATH=$sock
DOCKER_NETNS_FILE=$netns
ADMIN_USERNAME=$admin_user
ADMIN_EMAIL=$admin_email
DB_HOST_PORT=$db_port
EOF
      [ -z "$TRUSTED_PROXY" ] || printf 'WOM_TRUSTED_PROXY=%s\n' "$TRUSTED_PROXY"
      capacity_profile
      [ -z "$pgdata_line" ] || printf '%s\n' "$pgdata_line"
      cat <<EOF
# secrets
POSTGRES_PASSWORD=$pg_pass
INTERNAL_TOKEN=$token
DATABASE_URL=postgresql://wom:$pg_pass@127.0.0.1:$db_port/wom?schema=public
# first-login password of the administrator; removed by app-setup.sh once the administrator exists (a copy: ~/.wom-admin-password)
ADMIN_PASSWORD=$admin_pass
EOF
    } > "$ENV_FILE"
    printf '%s\n' "$admin_pass" > "$ADMIN_PW_FILE"
  ) || die "не удалось записать $ENV_FILE"
  chmod 600 "$ENV_FILE" "$ADMIN_PW_FILE" 2>/dev/null || true
  ENV_CREATED=1
  ok ".env создан ($ENV_FILE, права 600), пароль администратора сохранён в $ADMIN_PW_FILE"
  [ -z "$netns" ] && note "DOCKER_NETNS_FILE пуст: файл \$XDG_RUNTIME_DIR/dockerd-rootless/netns не найден (демон без --detach-netns, как на dev); если egress-guard не станет healthy, задай путь вручную"
  return 0
}

# update_managed KEY VALUE LABEL: sets a managed key when it differs; says what changed (values are not secret here)
update_managed() {
  local key=$1 val=$2 cur
  cur=$(env_get "$key")
  if [ "$cur" = "$val" ] && env_has "$key"; then return 0; fi
  env_set "$key" "$val" || die "не удалось обновить $key в .env"
  note "обновлён ключ $key: '${cur:-<пусто>}' -> '${val:-<пусто>}'"
  ENV_CHANGED=1
}

update_env() {
  local reg
  ENV_CHANGED=0
  [ "$(stat -c %a "$ENV_FILE" 2>/dev/null || echo 600)" = 600 ] || { chmod 600 "$ENV_FILE" 2>/dev/null && note ".env: права исправлены на 600" || warn ".env доступен не только владельцу и не удалось исправить права"; }
  # the overlay is what makes the stack production: add it, keep any other compose file the owner listed
  case "$(env_get COMPOSE_FILE)" in
    *docker-compose.prod.yml*) ;;
    "") update_managed COMPOSE_FILE "$COMPOSE_OVERLAY" ;;
    *) update_managed COMPOSE_FILE "$(env_get COMPOSE_FILE):deploy/docker-compose.prod.yml" ;;
  esac
  if [ -n "$(env_get WOM_DOMAIN)" ] && [ "$(env_get WOM_DOMAIN)" != "$DOMAIN" ]; then
    warn "домен меняется с $(env_get WOM_DOMAIN) на $DOMAIN: Caddy запросит новый сертификат, старые ссылки перестанут работать"
  fi
  update_managed WOM_DOMAIN "$DOMAIN"
  if [ -n "$REGISTRATION" ]; then
    case "$REGISTRATION" in closed) reg=false ;; *) reg=true ;; esac
    update_managed REGISTRATION_ENABLED "$reg"
  elif ! env_has REGISTRATION_ENABLED; then
    update_managed REGISTRATION_ENABLED true
  fi
  if [ -n "$CONTACT_URL" ]; then update_managed CONTACT_URL "$CONTACT_URL"; fi
  if [ -n "$TRUSTED_PROXY" ]; then update_managed WOM_TRUSTED_PROXY "$TRUSTED_PROXY"; fi
  if [ -n "$ADMIN_USER" ]; then update_managed ADMIN_USERNAME "$ADMIN_USER"; fi
  if [ -n "$ADMIN_EMAIL" ]; then update_managed ADMIN_EMAIL "$ADMIN_EMAIL"; fi
  env_has DOCKER_SOCKET_PATH || update_managed DOCKER_SOCKET_PATH "${XDG_RUNTIME_DIR}/docker.sock"
  local netns
  netns=$(detect_netns_file)
  if [ -n "$netns" ]; then update_managed DOCKER_NETNS_FILE "$netns"; fi
  # INTERNAL_TOKEN is the one secret that is safe to supply when it is missing: nothing else depends on its value.
  # POSTGRES_PASSWORD is never invented (the existing database was initialised with whatever it was), ADMIN_PASSWORD neither.
  if [ -z "$(env_get INTERNAL_TOKEN)" ]; then
    local token
    token=$(rand_hex 32) || die "не удалось получить случайные байты для INTERNAL_TOKEN"
    env_set INTERNAL_TOKEN "$token" || die "не удалось записать INTERNAL_TOKEN"
    note "в .env не было INTERNAL_TOKEN: сгенерирован новый"
    ENV_CHANGED=1
  fi
  if ! env_has PGDATA_MOUNT && ! db_volume_exists; then
    note "в .env нет PGDATA_MOUNT: база остаётся там, где была. Перенос на $PGDATA_DIR описан в runbook §6a (до переноса данных его не задавай)"
  fi
  [ "$ENV_CHANGED" = 0 ] && ok ".env уже в нужном состоянии (секреты не тронуты)" || ok ".env обновлён (секреты не тронуты)"
}

ensure_env() {
  step "2. Файл .env"
  if [ "$DRY_RUN" = 1 ]; then
    if [ -f "$ENV_FILE" ]; then
      plan ".env есть: обновлю только управляемые ключи (WOM_DOMAIN=$DOMAIN, COMPOSE_FILE с prod-оверлеем${REGISTRATION:+, REGISTRATION_ENABLED ($REGISTRATION)}${CONTACT_URL:+, CONTACT_URL}${ADMIN_USER:+, ADMIN_USERNAME}${ADMIN_EMAIL:+, ADMIN_EMAIL}, DOCKER_NETNS_FILE, если найден), секреты не трогаю"
    else
      plan "создам .env с правами 600: COMPOSE_FILE, WOM_DOMAIN=$DOMAIN, REGISTRATION_ENABLED=$([ "${REGISTRATION:-open}" = closed ] && echo false || echo true), ADMIN_USERNAME=${ADMIN_USER:-admin}, ADMIN_EMAIL=${ADMIN_EMAIL:-admin@$(is_ipv4 "$DOMAIN" && echo game.local || echo "$DOMAIN")}, DOCKER_NETNS_FILE, PGDATA_MOUNT=$PGDATA_DIR"
      plan "случайные секреты (POSTGRES_PASSWORD, INTERNAL_TOKEN, ADMIN_PASSWORD) через openssl; пароль администратора сохраню в $ADMIN_PW_FILE (600), на экран он не выводится"
      if pgdata_in_use; then plan "ВНИМАНИЕ: $PGDATA_DIR уже содержит базу, а .env нет: настоящий запуск остановится"; fi
    fi
    return 0
  fi
  if [ -f "$ENV_FILE" ]; then update_env; else create_env; fi
  # the compose files must accept the result before anything is built
  local cfg_err
  cfg_err=$(dc config --quiet 2>&1 >/dev/null) || {
    printf '%s\n' "$cfg_err" | sed 's/^/   /' >&2
    die "docker compose не принимает .env и compose-файлы (docker compose config); поправь .env и запусти снова"
  }
}

# ---- 3. systemd units -----------------------------------------------------------------------------------------------
render_unit() { # file -> stdout: the unit with %h/wom-platform replaced when the repository lives elsewhere
  if [ "$REPO_DIR" = "$HOME/wom-platform" ]; then cat "$1"; else sed "s|%h/wom-platform|$REPO_DIR|g" "$1"; fi
}

install_unit() { # name
  local src="$REPO_DIR/deploy/$1" dst="$UNIT_DIR/$1" tmp
  [ -f "$src" ] || die "нет файла $src"
  tmp=$(mktemp "$UNIT_DIR/.wom-unit.XXXXXX") || die "не могу писать в $UNIT_DIR"
  render_unit "$src" > "$tmp"
  chmod 644 "$tmp"
  if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$dst"
    UNITS_CHANGED=1
    note "установлен $dst"
  fi
}

hostwatch_configured() {
  local f="$HOME/.wom-hostwatch.env"
  [ -f "$f" ] && grep -qE '^TG_BOT_TOKEN=.+' "$f" && grep -qE '^TG_CHAT_ID=.+' "$f"
}

install_units() {
  step "3. Юниты systemd --user"
  local u units="wom.service wom-backup.service wom-backup.timer wom-failed@.service"
  [ "$HOSTWATCH" != 1 ] || units="$units wom-hostwatch.service wom-hostwatch.timer"
  if [ "$DRY_RUN" = 1 ]; then
    plan "скопирую в $UNIT_DIR: $units"
    plan "systemctl --user daemon-reload; enable wom.service; enable --now wom-backup.timer"
    if [ "$HOSTWATCH" = 1 ]; then
      if hostwatch_configured; then plan "enable --now wom-hostwatch.timer"
      else plan "hostwatch: юниты скопирую, ~/.wom-hostwatch.env создам заготовкой (600), таймер включу после заполнения Telegram-данных"; fi
    fi
    return 0
  fi
  UNITS_CHANGED=0
  mkdir -p "$UNIT_DIR"
  for u in $units; do install_unit "$u"; done
  sctl daemon-reload || die "systemctl --user daemon-reload не прошёл"
  # wom.service is only ENABLED here: starting it would run `docker compose up` (a build) before deploy.sh; it is started after the deploy
  sctl enable wom.service >/dev/null 2>&1 || die "systemctl --user enable wom.service не прошёл"
  sctl enable --now wom-backup.timer >/dev/null 2>&1 || die "systemctl --user enable --now wom-backup.timer не прошёл"
  ok "юниты wom.service и wom-backup.timer установлены и включены (ночной бэкап в 03:30)"
  if [ "$HOSTWATCH" = 1 ]; then
    if [ ! -e "$HOME/.wom-hostwatch.env" ]; then
      ( umask 077; cat > "$HOME/.wom-hostwatch.env" <<'EOF'
# Telegram for host alerts (deploy/hostwatch.sh, deploy/notify.sh). Fill both values, then:
#   systemctl --user enable --now wom-hostwatch.timer
# Optional thresholds: HOST_DISK_PCT, DISK_PATHS, LOAD_MAX, CERT_DAYS, BACKUP_DIR, BACKUP_MAX_AGE_MIN, KIND_NODES_MAX
TG_BOT_TOKEN=
TG_CHAT_ID=
EOF
      )
      chmod 600 "$HOME/.wom-hostwatch.env" 2>/dev/null || true
    fi
    if hostwatch_configured; then
      sctl enable --now wom-hostwatch.timer >/dev/null 2>&1 || die "systemctl --user enable --now wom-hostwatch.timer не прошёл"
      ok "сторож хоста включён (wom-hostwatch.timer, каждые 5 минут)"
    else
      note "сторож хоста: юниты установлены, но таймер НЕ включён: в ~/.wom-hostwatch.env нет TG_BOT_TOKEN и TG_CHAT_ID (без них он падал бы каждые 5 минут)"
      NEXT+=("Сторож хоста: впиши TG_BOT_TOKEN и TG_CHAT_ID в ~/.wom-hostwatch.env, затем: systemctl --user enable --now wom-hostwatch.timer")
    fi
  fi
}

# ---- 4. restore of a dump -------------------------------------------------------------------------------------------
db_scalar() { # SQL -> trimmed first line of the answer (empty on any failure)
  dc exec -T db psql -U wom -d wom -tAc "$1" 2>/dev/null | tr -d '[:space:]' || true
}

restore_dump() {
  step "4. Восстановление дампа (до первого входа)"
  local marker="$HOME/.wom-restore-in-progress" has users
  if [ "$DRY_RUN" = 1 ]; then
    plan "docker compose up -d --wait db; если база пуста (нет схемы или нет пользователей): пересоздам базу wom и залью $DUMP, затем deploy.sh применит новые миграции"
    plan "непустую базу не трогаю: остановлюсь с объяснением"
    return 0
  fi
  dc up -d --wait db >/dev/null 2>&1 || die "контейнер db не поднялся (docker compose logs db)"
  has=$(db_scalar "select to_regclass('public.\"TrainingSession\"') is not null")
  case "$has" in
    f) ;;
    t)
      users=$(db_scalar 'select count(*) from "User"')
      if [ -e "$marker" ]; then
        note "прошлое восстановление не дошло до конца (метка $marker): база будет создана заново"
      elif [ "$users" != 0 ]; then
        die "в базе уже есть данные (пользователей: ${users:-неизвестно}): дамп не восстанавливаю, чтобы не затереть их. Восстановление возможно только в пустую базу; для живой базы см. «Восстановление из дампа» в docs/runbook-prod-install.md"
      fi ;;
    *) die "база не отвечает: не могу понять, пуста ли она (docker compose logs db)" ;;
  esac
  : > "$marker"
  dc stop web orchestrator >/dev/null 2>&1 || true
  dc exec -T db psql -U wom -d postgres -c 'DROP DATABASE IF EXISTS wom WITH (FORCE)' -c 'CREATE DATABASE wom OWNER wom' >/dev/null \
    || die "не удалось пересоздать базу wom"
  if ! gunzip -c "$DUMP" | dc exec -T db psql -U wom -d wom -v ON_ERROR_STOP=1 -q >/dev/null; then
    die "восстановление дампа оборвалось на ошибке (метка $marker оставлена: повторный запуск пересоздаст базу и начнёт заново)"
  fi
  rm -f "$marker"
  ok "дамп $(basename "$DUMP") восстановлен; deploy.sh применит миграции, появившиеся после дампа"
  NEXT+=("Дамп не содержит .env: пароли и INTERNAL_TOKEN в новом .env другие. Пароль админа из дампа сохраняется (сид его не меняет); ~/.wom-admin-password к нему не относится")
}

# ---- 5. deploy ------------------------------------------------------------------------------------------------------
run_deploy() {
  step "5. Сборка и запуск (scripts/deploy.sh: образы, сценарии, миграции, сид, стек; первый запуск занимает долго)"
  if [ "$DRY_RUN" = 1 ]; then
    plan "bash scripts/deploy.sh ($( [ -n "$(cd "$REPO_DIR" && git remote get-url origin 2>/dev/null)" ] && echo 'у репозитория есть origin: режим git, если не задан WOM_DEPLOY_MODE=local' || echo 'режим local: remote origin нет' ))"
    plan "systemctl --user start wom.service"
    return 0
  fi
  bash scripts/deploy.sh || die "scripts/deploy.sh не прошёл (причина выше; платформа не поднята или осталась прежней). Повторный запуск app-setup.sh продолжит с этого места"
  DEPLOYED=1
  ok "deploy.sh завершён"
  if sctl start wom.service >/dev/null 2>&1; then ok "wom.service запущен (автозапуск после перезагрузки)"
  else attn "wom.service не запустился (systemctl --user status wom.service): после перезагрузки сервера стек поднимут только контейнеры с restart: unless-stopped"; fi
}

# ---- 7. health ------------------------------------------------------------------------------------------------------
health_attempts() { local w=${WOM_HEALTH_WAIT_SEC:-300} p=${WOM_HEALTH_POLL_SEC:-5}; local n=$((w / p)); [ "$n" -ge 1 ] || n=1; printf '%s' "$n"; }

wait_inside() {
  local i n out
  n=$(health_attempts)
  for i in $(seq 1 "$n"); do
    out=$(dc exec -T web wget -qO- -T 3 http://127.0.0.1:3000/api/health 2>/dev/null || true)
    if printf '%s' "$out" | grep -q '"ok":true'; then HEALTH_JSON=$out; return 0; fi
    repeat_sleep "${WOM_HEALTH_POLL_SEC:-5}"
  done
  HEALTH_JSON=$out
  return 1
}

local_addresses() {
  { ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; hostname -I 2>/dev/null | tr ' ' '\n'; } | grep -E '^[0-9]' | sort -u || true
}
dns_addresses() { getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true; }

# prints what is known about the DNS record; returns 1 when the name does not resolve at all
dns_diagnosis() {
  local dns mine a hit=0
  dns=$(dns_addresses); mine=$(local_addresses)
  if [ -z "$dns" ]; then
    note "DNS: имя $DOMAIN пока не resolve'ится. Создай A-запись $DOMAIN -> IP этого сервера у регистратора и подожди обновления DNS (от минут до часов)"
    return 1
  fi
  for a in $dns; do case " $(echo $mine) " in *" $a "*) hit=1 ;; esac; done
  if [ "$hit" = 1 ]; then
    note "DNS: $DOMAIN указывает на этот сервер ($(echo $dns))"
  else
    note "DNS: $DOMAIN указывает на $(echo $dns), а адреса этого сервера: $(echo $mine). Если это не NAT провайдера, поправь A-запись: пока она не ведёт сюда, Let's Encrypt не выдаст сертификат"
  fi
  return 0
}

probe_public() { # 0 when https://DOMAIN/api/health answers ok:true
  local out
  out=$(curl -fsS $(is_ipv4 "$DOMAIN" && echo -k) -m 10 "https://$DOMAIN/api/health" 2>/dev/null) || return 1
  printf '%s' "$out" | grep -q '"ok":true' || return 1
  HEALTH_JSON=$out
}
probe_loopback() { # the same through this host's own Caddy, DNS bypassed
  local out
  out=$(curl -fsS -m 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null) || return 1
  printf '%s' "$out" | grep -q '"ok":true'
}

check_health() {
  step "7. Проверка здоровья"
  if [ "$DRY_RUN" = 1 ]; then
    plan "внутри сети compose: web -> /api/health (до $(health_attempts) попыток)"
    plan "снаружи: https://$DOMAIN/api/health, пока Caddy получает сертификат (до ${WOM_HEALTH_WAIT_SEC:-300} с); при неудаче объясню состояние DNS"
    return 0
  fi
  if wait_inside; then ok "health внутри сети compose: $HEALTH_JSON"
  else die "web не ответил на /api/health изнутри за ${WOM_HEALTH_WAIT_SEC:-300} с (docker compose logs --tail=100 web orchestrator): $HEALTH_JSON"; fi

  local i n public=0 loop=0
  n=$(health_attempts)
  if is_ipv4 "$DOMAIN"; then
    note "режим без домена: https://$DOMAIN с самоподписанным сертификатом Caddy (проверяю с ключом -k)"
  elif ! dns_diagnosis; then
    # nothing will get a certificate before the record exists: do not burn five minutes
    n=1
  fi
  for i in $(seq 1 "$n"); do
    if probe_public; then public=1; break; fi
    probe_loopback && loop=1
    [ "$i" -lt "$n" ] || break
    if [ "$i" = 1 ]; then
      if is_ipv4 "$DOMAIN"; then note "жду, пока Caddy выпустит собственный сертификат для $DOMAIN…"
      else note "жду сертификат Let's Encrypt для $DOMAIN (порт 80 должен быть доступен из интернета)…"; fi
    fi
    repeat_sleep "${WOM_HEALTH_POLL_SEC:-5}"
  done
  if [ "$public" = 1 ]; then
    ok "https://$DOMAIN/api/health отвечает: $HEALTH_JSON"
  else
    if [ "$loop" = 1 ]; then
      attn "https://$DOMAIN с самого сервера по его адресу отвечает, а по имени домена нет: проверь A-запись и то, что порты 80/443 открыты снаружи (у хостера, не только в ufw)"
    elif is_ipv4 "$DOMAIN"; then
      attn "https://$DOMAIN пока не отвечает по TLS. Платформа внутри работает; смотри docker compose logs caddy и проверь, что порты 80 и 443 хоста не заняты и не закрыты фаерволом"
      dc logs --tail 40 caddy 2>&1 | grep -iE 'obtain|tls|error' | tail -n 5 | sed 's/^/      caddy: /' || true
    else
      attn "https://$DOMAIN пока не отвечает: сертификат не получен или DNS указывает не сюда. Платформа внутри работает; после правки DNS Caddy сам получит сертификат (docker compose logs caddy)"
      dc logs --tail 40 caddy 2>&1 | grep -iE 'obtain|acme|challenge|error' | tail -n 5 | sed 's/^/      caddy: /' || true
    fi
    NEXT+=("Проверь снаружи: curl -s https://$DOMAIN/api/health (ожидается \"ok\":true)")
  fi
  case "$HEALTH_JSON" in
    *'"egress":"ok"'*) ok "egress-guard: правила подтверждены" ;;
    *) attn "в ответе /api/health egress не ok ($HEALTH_JSON): Kubernetes-сценарии откажут; проверь DOCKER_NETNS_FILE в .env и docker logs wom_egress_guard" ;;
  esac
}

# ---- 8. smoke test --------------------------------------------------------------------------------------------------
run_smoke() {
  step "8. Дымовой тест сценариев (--smoke $SMOKE)"
  if [ "$SMOKE" = none ]; then note "пропущен (--smoke none)"; return 0; fi
  local dirs=(scenarios/nginx-502-upstream) log="$HOME/install-smoke.log" d wom=./node_modules/.bin/wom
  [ "$SMOKE" != full ] || dirs+=(scenarios/broken-probes)
  if [ "$DRY_RUN" = 1 ]; then plan "wom scenario test: ${dirs[*]}"; return 0; fi
  if [ ! -x "$wom" ]; then attn "дымовой тест не выполнен: нет $wom (его ставит deploy.sh командой npm ci)"; return 0; fi
  if [ "$SMOKE" = full ] && ! command -v kind >/dev/null 2>&1; then attn "дымовой тест full не выполнен: нет kind в PATH (~/.local/bin/kind ставит host-setup.sh)"; return 0; fi
  : > "$log"
  for d in "${dirs[@]}"; do
    note "wom scenario test $d … (до нескольких минут)"
    if { if command -v timeout >/dev/null 2>&1; then timeout "${WOM_SMOKE_TIMEOUT_SEC:-1800}" "$wom" scenario test "$d"; else "$wom" scenario test "$d"; fi; } >> "$log" 2>&1; then
      ok "сценарий $(basename "$d"): тест пройден"
    else
      tail -n 15 "$log" | sed 's/^/      /' >&2
      attn "сценарий $(basename "$d"): тест НЕ пройден (полный лог $log)"
    fi
  done
}

# ---- 9. the administrator's first-login password leaves .env --------------------------------------------------------
scrub_admin_password() {
  step "9. Пароль первого входа"
  if [ "$DRY_RUN" = 1 ]; then plan "когда администратор появится в базе, ADMIN_PASSWORD будет удалён из .env и оркестратор пересоздан (runbook §5); пароль останется в $ADMIN_PW_FILE"; return 0; fi
  if ! env_has ADMIN_PASSWORD; then note "ADMIN_PASSWORD в .env уже нет"; return 0; fi
  local admins
  admins=$(db_scalar "select count(*) from \"User\" where role = 'admin'")
  case "$admins" in
    ''|0|*[!0-9]*) attn "в базе не нашёлся администратор (ответ: '${admins:-пусто}'): ADMIN_PASSWORD оставлен в .env; выясни причину (docker compose logs orchestrator, сид в deploy.sh) и удали строку вручную после первого входа"; return 0 ;;
  esac
  # the .env line is the only copy when the file was not written by this script (an older .env): keep the value before dropping it
  if [ ! -s "$ADMIN_PW_FILE" ] && [ -n "$(env_get ADMIN_PASSWORD)" ]; then
    if ! ( umask 077; printf '%s\n' "$(env_get ADMIN_PASSWORD)" > "$ADMIN_PW_FILE" ) 2>/dev/null; then
      attn "не удалось сохранить пароль админа в $ADMIN_PW_FILE: ADMIN_PASSWORD оставлен в .env, удали строку вручную после первого входа"; return 0
    fi
    chmod 600 "$ADMIN_PW_FILE" 2>/dev/null || true
    note "пароль первого входа из .env сохранён в $ADMIN_PW_FILE (600)"
  fi
  # drop the line without echoing it
  local tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX") || { attn "не удалось убрать ADMIN_PASSWORD из .env"; return 0; }
  if grep -v '^ADMIN_PASSWORD=' "$ENV_FILE" > "$tmp"; then mv "$tmp" "$ENV_FILE"; else rm -f "$tmp"; fi
  if dc up -d orchestrator >/dev/null 2>&1; then
    ok "ADMIN_PASSWORD удалён из .env, оркестратор пересоздан без него (администратор в базе: $admins)"
  else
    attn "ADMIN_PASSWORD удалён из .env, но оркестратор не пересоздан (docker compose up -d orchestrator): пароль ещё виден в его окружении"
  fi
}

# ---- 10. report -----------------------------------------------------------------------------------------------------
version_of() { "$@" 2>/dev/null | head -n 1 || true; }

write_report() { # EXIT_CODE
  local rc=$1 status line
  case "$rc" in
    0) status="готово" ;;
    4) status="готово, но нужно внимание" ;;
    *) status="ОСТАНОВЛЕНО на шаге «$PHASE» (код выхода $rc)" ;;
  esac
  (
    umask 077
    {
      echo "$APP_TITLE: отчёт установки ($(date '+%F %T %z'))"
      echo "Состояние: $status"
      echo
      echo "Адрес:            https://$DOMAIN"
      echo "Администратор:    ${ADMIN_USER:-$(env_get ADMIN_USERNAME)} (${ADMIN_EMAIL:-$(env_get ADMIN_EMAIL)})"
      if [ -f "$ADMIN_PW_FILE" ]; then echo "Пароль админа:    в файле $ADMIN_PW_FILE (прочитать: cat $ADMIN_PW_FILE; это пароль первого входа, после его смены файл удали)"
      else echo "Пароль админа:    файла $ADMIN_PW_FILE нет (используется пароль из дампа или заданный вручную)"; fi
      echo "Регистрация:      $([ "$(env_get REGISTRATION_ENABLED)" = false ] && echo закрыта || echo открыта)"
      echo "Каталог:          $REPO_DIR (.env с секретами: $ENV_FILE, права 600)"
      echo
      echo "Версии: коммит $(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo '-'); docker $(version_of docker version --format '{{.Server.Version}}'); compose $(version_of docker compose version --short); node $(version_of node --version); kind $(version_of kind version)"
      echo
      echo "Что сделано:"
      for line in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "  $line"; done
      if [ "${#ATTN[@]}" -gt 0 ]; then
        echo
        echo "Требует внимания:"
        for line in "${ATTN[@]}"; do echo "  - $line"; done
      fi
      if [ "${#NEXT[@]}" -gt 0 ]; then
        echo
        echo "Дальше вручную:"
        for line in "${NEXT[@]}"; do echo "  - $line"; done
      fi
    } > "$REPORT_FILE"
  ) 2>/dev/null || true
}

# ---- main -----------------------------------------------------------------------------------------------------------
on_exit() {
  local rc=$?
  if [ "$REPORT_ENABLED" = 1 ]; then write_report "$rc"; fi
  return 0
}

print_plan_header() {
  say "$APP_TITLE: настройка приложения на этом хосте"
  say "   домен: $DOMAIN; регистрация: ${REGISTRATION:-open (или как в .env)}; администратор: ${ADMIN_USER:-admin}; smoke: $SMOKE; hostwatch: $([ "$HOSTWATCH" = 1 ] && echo да || echo нет); дамп: ${DUMP:-нет}"
  say "   репозиторий: $REPO_DIR"
  if [ "$DRY_RUN" = 1 ]; then say "   РЕЖИМ --dry-run: ничего не меняется, дальше только план"; fi
}

main() {
  local rc=0
  parse_args "$@" || exit $?
  validate_args || exit 2
  init_runtime
  cd "$REPO_DIR" || die "не могу перейти в $REPO_DIR"
  print_plan_header

  step "1. Проверки окружения"
  preflight
  report_preflight || exit 2

  if [ "$DRY_RUN" != 1 ]; then
    REPORT_ENABLED=1
    trap on_exit EXIT
  fi

  ensure_env
  install_units
  if [ -n "$DUMP" ]; then restore_dump; fi
  run_deploy
  check_health
  run_smoke
  scrub_admin_password

  if [ "$DRY_RUN" = 1 ]; then
    say
    say "План напечатан, ничего не изменено. Запусти ту же команду без --dry-run."
    return 0
  fi

  NEXT+=("Бэкапы: ночные дампы лежат в /srv/backups на этом же сервере; настрой копию на другую машину (runbook §6), иначе потеря диска = потеря данных")
  NEXT+=("Telegram-оповещения о падениях: TG_BOT_TOKEN и TG_CHAT_ID в ~/.wom-hostwatch.env (chmod 600)")
  [ -n "$(env_get CONTACT_URL)" ] || NEXT+=("Ссылка «Написать нам»: задай --contact-url (https://t.me/<чат> или mailto:<адрес>) и запусти app-setup.sh ещё раз")

  step "Итог"
  say "   адрес:          https://$DOMAIN"
  say "   администратор:  ${ADMIN_USER:-$(env_get ADMIN_USERNAME)}"
  say "   пароль:         ssh wom@<хост> cat ~/.wom-admin-password   (на экран не выводится)"
  say "   отчёт:          $REPORT_FILE"
  if [ "${#ATTN[@]}" -gt 0 ]; then
    say "   требует внимания: ${#ATTN[@]} (см. отчёт)"
    rc=4
  fi
  return "$rc"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  main "$@"
  exit $?
fi
