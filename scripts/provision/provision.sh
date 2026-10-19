#!/usr/bin/env bash
# Game of Incidents: one command from the admin's machine takes a bare Debian 13 host to a working platform.
# Run it in the repository checkout (Git Bash, WSL, macOS or Linux):
#   bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com [options]
# Steps: local and remote pre-checks -> DNS check -> deliver the tree (git archive HEAD over ssh) -> host-setup.sh as root
#        -> copy to /home/wom/wom-platform + git init/commit -> app-setup.sh as wom -> https://DOMAIN/api/health from here.
# Secrets never appear in argv or in the output: the admin password is generated on the host and stays in ~/.wom-admin-password.
# Exit codes: 0 done; 1 a step failed; 2 bad arguments or a pre-check failed (ssh, OS, DNS, dirty tree, host-setup checks);
#             3 host-setup found foreign data in /srv/docker (rerun with --adopt if it is yours); 4 a confirmation is needed (--yes).
# Functions can be sourced and tested: main runs only when the file is executed.
set -euo pipefail

REMOTE_SRC=/root/wom-src
REMOTE_APP_USER=wom
REMOTE_APP_DIR=/home/wom/wom-platform
REMOTE_DUMP=/home/wom/wom-restore.sql.gz

# --- output (Russian for the reader, code and comments in English) ---------------------------------------------------
info() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
die() { # code message...
  local code=$1; shift
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit "$code"
}

usage() {
  cat <<'USAGE'
Использование:
  bash scripts/provision/provision.sh --host IP_ИЛИ_ИМЯ --domain ДОМЕН [параметры]

Что делает: проверяет хост и DNS, доставляет код по ssh, настраивает голый Debian 13 или Ubuntu 24.04 (host-setup.sh от root),
ставит платформу (app-setup.sh от пользователя wom) и проверяет https://ДОМЕН/api/health с твоей машины.
Перед запуском: у root на хосте должен работать вход по ssh-ключу, A-запись домена должна указывать на хост.

Обязательные:
  --host H              адрес хоста (IPv4 или имя)
  --domain D            домен платформы (A-запись уже указывает на хост); с --update не обязателен.
                        Без домена: если --host задан IPv4-адресом, можно опустить --domain, сайт будет по
                        https://IP с самоподписанным сертификатом Caddy (проверка скрипта, закрытые сети, стенды)

Подключение:
  --port N              порт ssh (22)
  --ssh-user U          пользователь ssh (root; другой не поддерживается)
  --ssh-key PATH        приватный ключ для ssh

Платформа (передаются в app-setup.sh, при обновлении игнорируются):
  --admin-user NAME     логин администратора (admin)
  --admin-email EMAIL   почта администратора
  --registration MODE   open или closed (open)
  --contact-url URL     адрес для ссылок «Написать нам» (Telegram, mailto:)
  --trusted-proxy CIDR  TCP-прокси перед хостом (один IP на несколько машин), передаёт адрес клиента PROXY protocol
  --dump FILE.sql.gz    восстановить дамп до первого входа (только при первой установке)
  --smoke MODE          none, linux или full: дымовой тест сценариев (linux)
  --hostwatch           включить локального сторожа хоста

Режим:
  --update              только доставить код и выполнить deploy.sh (без host-setup и без пересоздания .env)
  --full                пройти полный путь, даже если на хосте уже есть .env (идемпотентно, секреты не перезаписываются; нужен --yes)
  --adopt               передать --adopt в host-setup.sh: взять существующие данные в /srv/docker как свои
  --skip-dns-check      не останавливаться, если домен ещё не указывает на хост
  --allow-dirty         разрешить грязное дерево (доставляется только закоммиченное, то есть HEAD)
  --dry-run             ничего не делать: напечатать план (ssh и сеть не используются)
  --yes                 не спрашивать подтверждений
  -h, --help            эта справка

Если на хосте уже есть /home/wom/wom-platform/.env, скрипт сам работает как --update и говорит об этом.
Для обновления работающей платформы без явного --update нужен --yes (или ответ «y» в терминале).
Коды выхода: 0 готово; 1 шаг не удался; 2 неверные параметры или не прошла предпроверка;
             3 в /srv/docker чужие данные (повтори с --adopt, если они твои); 4 нужно подтверждение (--yes).
USAGE
}

# --- arguments -------------------------------------------------------------------------------------------------------
reset_defaults() {
  HOST=""; DOMAIN=""; PORT=22; SSH_USER=root; SSH_KEY=""
  ADMIN_USER=""; ADMIN_EMAIL=""; REGISTRATION=""; CONTACT_URL=""; DUMP=""; SMOKE=""; HOSTWATCH=0; TRUSTED_PROXY=""
  UPDATE=0; FULL=0; ADOPT=0; SKIP_DNS=0; ALLOW_DIRTY=0; DRY_RUN=0; YES=0
  MODE=""; SHOW_HELP=0; IP_MODE=0
}

parse_args() {
  reset_defaults
  local opt val
  while [ $# -gt 0 ]; do
    opt=$1
    val=""
    shift
    case "$opt" in
      --*=*) val=${opt#*=}; opt=${opt%%=*} ;;
    esac
    case "$opt" in
      --host|--domain|--port|--ssh-user|--ssh-key|--admin-user|--admin-email|--registration|--contact-url|--trusted-proxy|--dump|--smoke)
        if [ -z "$val" ]; then
          [ $# -gt 0 ] || die 2 "у параметра $opt нет значения (справка: --help)"
          val=$1; shift
        fi
        case "$opt" in
          --host) HOST=$val ;;
          --domain) DOMAIN=$val ;;
          --port) PORT=$val ;;
          --ssh-user) SSH_USER=$val ;;
          --ssh-key) SSH_KEY=$val ;;
          --admin-user) ADMIN_USER=$val ;;
          --admin-email) ADMIN_EMAIL=$val ;;
          --registration) REGISTRATION=$val ;;
          --contact-url) CONTACT_URL=$val ;;
          --trusted-proxy) TRUSTED_PROXY=$val ;;
          --dump) DUMP=$val ;;
          --smoke) SMOKE=$val ;;
        esac ;;
      --hostwatch) HOSTWATCH=1 ;;
      --update) UPDATE=1 ;;
      --full) FULL=1 ;;
      --adopt) ADOPT=1 ;;
      --skip-dns-check) SKIP_DNS=1 ;;
      --allow-dirty) ALLOW_DIRTY=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --yes|-y) YES=1 ;;
      -h|--help) SHOW_HELP=1 ;;
      *) die 2 "неизвестный параметр: $opt (справка: --help)" ;;
    esac
  done
}

# succeeds when the value holds a character that is special for a shell or for an .env line
has_shell_meta() {
  case "$1" in
    *[[:space:]]*|*\'*|*\"*|*\`*|*\$*|*\\*|*\;*|*\&*|*\|*|*\<*|*\>*|*\(*|*\)*) return 0 ;;
  esac
  return 1
}

valid_domain() {
  case "$1" in
    *.*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!a-z0-9.-]*|.*|*.|*..*|-*|*-.*|*.-*) return 1 ;;
  esac
  # the last label is a name, never a number: "999.1.1.1" is not a domain (and not an IPv4 address either)
  case "${1##*.}" in *[!0-9]*) ;; *) return 1 ;; esac
  [ "${#1}" -le 253 ]
}

is_ipv4() {
  local a b c d extra
  case "$1" in *[!0-9.]*|'') return 1 ;; esac
  IFS=. read -r a b c d extra <<<"$1"
  [ -z "$extra" ] || return 1
  for a in "$a" "$b" "$c" "$d"; do
    case "$a" in ''|*[!0-9]*) return 1 ;; esac
    [ "${#a}" -le 3 ] && [ "$a" -le 255 ] || return 1
  done
}
# the address of the site: a full domain, or an IPv4 address (no domain: Caddy then serves a self-signed certificate)
valid_site() { is_ipv4 "$1" || valid_domain "$1"; }

validate_args() {
  if [ "$SHOW_HELP" = 1 ]; then return 0; fi
  [ -n "$HOST" ] || die 2 "не указан --host (адрес хоста). Справка: --help"
  case "$HOST" in
    -*|*[!A-Za-z0-9.-]*) die 2 "--host '$HOST': допустимы только IPv4-адрес или имя из букв, цифр, точек и дефисов, без дефиса в начале" ;;
  esac
  case "$PORT" in
    ''|*[!0-9]*) die 2 "--port '$PORT': нужен номер порта от 1 до 65535" ;;
  esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die 2 "--port '$PORT': нужен номер порта от 1 до 65535"; fi
  case "$SSH_USER" in
    ''|-*|*[!a-z0-9_-]*) die 2 "--ssh-user '$SSH_USER': недопустимое имя пользователя" ;;
  esac
  [ "$SSH_USER" = root ] || die 2 "--ssh-user '$SSH_USER': поддерживается только root (настройка хоста требует root, sudo не используется)"
  if [ -n "$SSH_KEY" ] && [ ! -f "$SSH_KEY" ]; then die 2 "--ssh-key: файл '$SSH_KEY' не найден"; fi

  if [ -z "$DOMAIN" ]; then
    if [ "$UPDATE" != 1 ]; then
      is_ipv4 "$HOST" || die 2 "не указан --domain (домен платформы, A-запись уже должна указывать на хост). Без домена можно ставить только на хост, заданный IPv4-адресом. Справка: --help"
      DOMAIN=$HOST
    fi
  else
    DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
    valid_site "$DOMAIN" || die 2 "--domain '$DOMAIN': нужен полный домен без схемы и пути, например game.example.com (или IPv4-адрес, тогда будет самоподписанный сертификат)"
  fi
  if is_ipv4 "$DOMAIN"; then IP_MODE=1; fi

  case "$REGISTRATION" in ''|open|closed) ;; *) die 2 "--registration '$REGISTRATION': нужно open или closed" ;; esac
  case "$SMOKE" in ''|none|linux|full) ;; *) die 2 "--smoke '$SMOKE': нужно none, linux или full" ;; esac
  case "$ADMIN_USER" in
    '') ;;
    -*|*[!A-Za-z0-9._-]*) die 2 "--admin-user '$ADMIN_USER': допустимы буквы, цифры, точка, подчёркивание и дефис, без дефиса в начале" ;;
  esac
  if [ -n "$ADMIN_EMAIL" ]; then
    if has_shell_meta "$ADMIN_EMAIL"; then die 2 "--admin-email '$ADMIN_EMAIL': не похоже на адрес почты"; fi
    case "$ADMIN_EMAIL" in
      -*|*@*@*|@*|*@) die 2 "--admin-email '$ADMIN_EMAIL': не похоже на адрес почты" ;;
      *@*.*) ;;
      *) die 2 "--admin-email '$ADMIN_EMAIL': не похоже на адрес почты" ;;
    esac
  fi
  if [ -n "$CONTACT_URL" ]; then
    if has_shell_meta "$CONTACT_URL"; then die 2 "--contact-url: адрес не должен содержать пробелов и символов ' \" \` \$ \\ ; & | < > ( )"; fi
    case "$CONTACT_URL" in
      http://?*|https://?*|mailto:?*) ;;
      *) die 2 "--contact-url '$CONTACT_URL': нужен адрес вида https://t.me/... или mailto:..." ;;
    esac
  fi
  if [ -n "$DUMP" ]; then
    { [ -f "$DUMP" ] && [ -r "$DUMP" ]; } || die 2 "--dump: файл '$DUMP' не найден или не читается"
    case "$DUMP" in *.sql.gz) ;; *) die 2 "--dump: ожидается файл .sql.gz (дамп deploy/backup.sh)" ;; esac
  fi
  if [ "$UPDATE" = 1 ] && [ "$FULL" = 1 ]; then die 2 "--update и --full несовместимы"; fi
  return 0
}

# --- ssh ---------------------------------------------------------------------------------------------------------------
build_ssh_opts() {
  SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -p "$PORT")
  if [ -n "$SSH_KEY" ]; then SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes); fi
}

# rsh USER COMMAND: run on the host without reading our stdin
rsh() { ssh -n "${SSH_OPTS[@]}" "$1@$HOST" "$2"; }
# rsh_stdin USER COMMAND: the command reads our stdin (tree stream, dump)
rsh_stdin() { ssh "${SSH_OPTS[@]}" "$1@$HOST" "$2"; }

ssh_port_flag() { if [ "$PORT" != 22 ]; then printf -- '-p %s ' "$PORT"; fi; }

confirm() { # question
  if [ "$YES" = 1 ]; then return 0; fi
  if [ -t 0 ] && [ -t 1 ]; then
    local ans=""
    printf '%s [y/N] ' "$1"
    read -r ans || ans=""
    case "$ans" in y|Y|yes|YES|д|Д|да|Да) return 0 ;; esac
    die 4 "отменено"
  fi
  die 4 "$1 Без терминала продолжить можно только с флагом --yes."
}

# --- local checks --------------------------------------------------------------------------------------------------------
locate_repo() {
  REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
}

check_local() {
  command -v ssh >/dev/null 2>&1 || die 2 "на этой машине нет ssh (в Windows: Git for Windows или WSL)"
  command -v git >/dev/null 2>&1 || die 2 "на этой машине нет git"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die 2 "$REPO_ROOT не git-репозиторий: скрипт доставляет код командой git archive HEAD, запускай его из клонированного репозитория"
  git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null || die 2 "в репозитории нет ни одного коммита"
  local f need="scripts/deploy.sh"
  if [ "$UPDATE" != 1 ]; then need="scripts/provision/host-setup.sh scripts/provision/app-setup.sh scripts/deploy.sh"; fi
  for f in $need; do
    if ! git -C "$REPO_ROOT" cat-file -e "HEAD:$f" 2>/dev/null; then
      if [ "$DRY_RUN" = 1 ]; then
        warn "файла $f нет в последнем коммите (HEAD): настоящий запуск остановится (доставляется только закоммиченное)"
      else
        die 2 "файла $f нет в последнем коммите (HEAD): доставляется только закоммиченное. Закоммить его и запусти снова"
      fi
    fi
  done
  local dirty
  dirty=$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)
  if [ -n "$dirty" ]; then
    if [ "$ALLOW_DIRTY" = 1 ]; then
      warn "в дереве есть незакоммиченные правки; на хост уедет только HEAD ($(git -C "$REPO_ROOT" rev-parse --short HEAD)), правки не попадут"
    elif [ "$DRY_RUN" = 1 ]; then
      warn "в дереве есть незакоммиченные правки: настоящий запуск остановится (закоммить их или добавь --allow-dirty)"
    else
      printf '%s\n' "$dirty" >&2
      die 2 "в рабочем дереве есть незакоммиченные правки, а на хост уедет только HEAD. Закоммить их или запусти с --allow-dirty"
    fi
  fi
  local untracked
  untracked=$(git -C "$REPO_ROOT" ls-files --others --exclude-standard | wc -l | tr -d ' ')
  if [ "$untracked" != 0 ]; then
    warn "в дереве $untracked неотслеживаемых файлов (git status): на хост уедет только закоммиченное (HEAD), их там не будет"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "на этой машине нет curl: итоговую проверку /api/health я пропущу"
  fi
}

# --- host checks ---------------------------------------------------------------------------------------------------------
check_ssh() {
  local err="" copy
  if ! err=$(rsh "$SSH_USER" true 2>&1); then
    printf '%s\n' "$err" >&2
    case "$err" in
      *"HOST IDENTIFICATION HAS CHANGED"*|*"Host key verification failed"*)
        die 2 "ssh-ключ хоста $HOST не совпал с записанным в known_hosts. Если ты сам переустановил ОС хоста, удали старую запись: ssh-keygen -R $HOST (для порта не 22: ssh-keygen -R '[$HOST]:$PORT'), и запусти снова. Если ты ничего не переустанавливал, не продолжай: это может быть подмена хоста" ;;
    esac
    copy="ssh-copy-id $(ssh_port_flag)"
    if [ -n "$SSH_KEY" ]; then copy="$copy-i $SSH_KEY.pub "; fi
    die 2 "не удалось войти на $SSH_USER@$HOST по ssh-ключу (порт $PORT). Если на хосте пока только пароль, один раз выполни: ${copy}$SSH_USER@$HOST, затем запусти этот скрипт снова. Если ключ лежит не в ~/.ssh, укажи --ssh-key; если у ключа есть парольная фраза, сначала добавь его в ssh-agent (ssh-add)"
  fi
  info "ssh: $SSH_USER@$HOST доступен по ключу"
}

check_host_os() {
  local out id version uid
  out=$(rsh "$SSH_USER" '. /etc/os-release && echo "$ID $VERSION_ID" && id -u') || die 2 "не удалось прочитать /etc/os-release на хосте"
  id=$(printf '%s\n' "$out" | sed -n '1p' | cut -d' ' -f1)
  version=$(printf '%s\n' "$out" | sed -n '1p' | cut -d' ' -f2)
  uid=$(printf '%s\n' "$out" | sed -n '2p')
  case "$id $version" in
    "debian 13"|"ubuntu 24.04") ;;
    *) die 2 "на хосте $id $version, а нужен Debian 13 (trixie) или Ubuntu 24.04 LTS. Переустанови ОС через панель провайдера и запусти скрипт снова" ;;
  esac
  [ "$uid" = 0 ] || die 2 "на хосте ssh вошёл не под root (uid=$uid): настройка хоста требует root"
  info "ОС хоста: $id $version, вход под root"
}

host_has_env() {
  local out
  out=$(rsh "$SSH_USER" "test -f $REMOTE_APP_DIR/.env && echo yes || echo no") || die 1 "не удалось проверить $REMOTE_APP_DIR/.env на хосте"
  [ "$out" = yes ]
}

# DNS as the HOST sees it: every A record of the domain must be an address of this host
check_dns() {
  local out dips="" hips="" ip line bad=""
  out=$(rsh "$SSH_USER" "for ip in \$(getent ahostsv4 '$DOMAIN' | awk '{print \$1}' | sort -u); do echo \"D \$ip\"; done; for ip in \$(getent ahostsv4 '$HOST' | awk '{print \$1}' | sort -u) \$(hostname -I 2>/dev/null); do echo \"H \$ip\"; done") \
    || die 1 "не удалось выполнить DNS-проверку на хосте"
  hips=" $HOST "
  while IFS= read -r line; do
    case "$line" in
      "D "*) dips="$dips ${line#D } " ;;
      "H "*) hips="$hips ${line#H } " ;;
    esac
  done <<EOF
$out
EOF
  if [ -z "${dips// /}" ]; then
    if [ "$SKIP_DNS" = 1 ]; then warn "домен $DOMAIN пока не резолвится (A-записи нет); иду дальше из-за --skip-dns-check"; return 0; fi
    die 2 "домен $DOMAIN не резолвится: A-записи нет. Создай у DNS-провайдера A-запись $DOMAIN -> $HOST, подожди TTL (минуты, иногда часы), проверь 'nslookup $DOMAIN' и запусти скрипт снова. Если сертификат нужен позже, можно пройти дальше с --skip-dns-check, но Caddy получит сертификат, только когда DNS заработает"
  fi
  for ip in $dips; do
    case "$hips" in *" $ip "*) ;; *) bad="$bad $ip" ;; esac
  done
  if [ -n "$bad" ]; then
    if [ "$SKIP_DNS" = 1 ]; then warn "A-запись $DOMAIN указывает не на хост:$bad (хост $HOST); иду дальше из-за --skip-dns-check"; return 0; fi
    die 2 "A-запись $DOMAIN указывает на$bad, а хост это $HOST. Все A-записи домена должны вести прямо на этот сервер (иначе Let's Encrypt не выдаст сертификат, а адреса клиентов станут общими). Поправь запись, подожди TTL и запусти снова. Если так задумано (NAT, прокси), добавь --skip-dns-check"
  fi
  info "DNS: $DOMAIN указывает на хост ($(printf '%s' "$dips" | tr -s ' ' | sed 's/^ //; s/ $//'))"
  warn "порты 80 и 443 снаружи отсюда не проверить: убедись, что фаервол провайдера их не закрывает (нужны для сертификата Let's Encrypt)"
}

# --- delivery ----------------------------------------------------------------------------------------------------------
deliver_tree() {
  local sha
  sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
  info "доставляю дерево $sha (git archive HEAD) в $REMOTE_SRC на хосте"
  git -C "$REPO_ROOT" archive --format=tar HEAD \
    | rsh_stdin "$SSH_USER" "set -e; rm -rf $REMOTE_SRC.tmp; mkdir -p $REMOTE_SRC.tmp; tar -x -C $REMOTE_SRC.tmp; rm -rf $REMOTE_SRC; mv $REMOTE_SRC.tmp $REMOTE_SRC" \
    || die 1 "не удалось доставить дерево на хост"
}

remote_sync_script() {
  cat <<EOF
set -e
src=$REMOTE_SRC
dst=$REMOTE_APP_DIR
id $REMOTE_APP_USER >/dev/null 2>&1 || { echo "пользователя $REMOTE_APP_USER на хосте нет: host-setup.sh не выполнялся" >&2; exit 1; }
[ -d "\$dst" ] || install -d -o $REMOTE_APP_USER -g $REMOTE_APP_USER -m 755 "\$dst"
# .git, .env and node_modules of the host stay as they are (excluded paths are protected from --delete);
# ignored local files (.env.* copies, dumps, .wom-*.env) are protected from --delete too, but tracked ones still update
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --chown=$REMOTE_APP_USER:$REMOTE_APP_USER --exclude=/.git --exclude=/.env --exclude=node_modules \\
    --filter='P /.env.*' --filter='P /.wom-*.env' --filter='P *.sql.gz' "\$src/" "\$dst/"
else
  (cd "\$src" && tar -c --owner=$REMOTE_APP_USER --group=$REMOTE_APP_USER .) | tar -x -C "\$dst"
fi
EOF
}

remote_commit_script() { # sha
  cat <<EOF
set -e
cd $REMOTE_APP_DIR
if [ ! -d .git ]; then git init -q; git symbolic-ref HEAD refs/heads/main; fi
# .env is in .gitignore, so add skips it; a pathspec exclusion for an ignored file makes some git versions exit 1
git add -A -- .
git rm -q --cached --ignore-unmatch -- .env
if git diff --cached --quiet; then
  echo "дерево на хосте совпадает с последним коммитом"
else
  git -c user.name=wom-provision -c user.email=wom@localhost commit -q -m "provision: $1"
  echo "коммит на хосте: \$(git rev-parse --short HEAD)"
fi
EOF
}

sync_to_app_dir() {
  local sha
  sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
  info "копирую дерево в $REMOTE_APP_DIR (.env, .git и node_modules хоста не трогаю)"
  rsh "$SSH_USER" "$(remote_sync_script)" || die 1 "не удалось скопировать дерево в $REMOTE_APP_DIR"
  rsh "$REMOTE_APP_USER" "$(remote_commit_script "$sha")" \
    || die 1 "не удалось сделать git init/commit в $REMOTE_APP_DIR под пользователем $REMOTE_APP_USER (вход wom по ssh-ключу не работает?)"
}

# environment for commands run as wom over a non-login ssh session
wom_env_script() {
  cat <<'EOF'
export PATH="$HOME/.local/bin:$PATH"
uid=$(id -u)
export XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus DOCKER_HOST=unix:///run/user/$uid/docker.sock WOM_DEPLOY_MODE=local
for _i in $(seq 1 30); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 1; done
EOF
}

# --- steps -------------------------------------------------------------------------------------------------------------
run_host_setup() {
  local rc=0 args=""
  if [ "$ADOPT" = 1 ]; then args=" --adopt"; fi
  step "Настройка хоста (host-setup.sh от root)"
  rsh "$SSH_USER" "cd $REMOTE_SRC && bash scripts/provision/host-setup.sh$args" || rc=$?
  case "$rc" in
    0) info "хост настроен; отчёт на хосте: /root/wom-host-setup.report" ;;
    2) die 2 "host-setup.sh не пропустил проверку окружения (ОС, ресурсы: минимум 4 CPU, 8 ГБ RAM, 60 ГБ диска; рекомендуется 8 CPU и 32 ГБ). Причина в выводе выше" ;;
    3) die 3 "в /srv/docker уже лежат чужие данные, host-setup.sh остановился, ничего не тронув. Если это данные прежней установки платформы и их надо сохранить, запусти снова с --adopt" ;;
    *) die 1 "host-setup.sh завершился с кодом $rc (причина в выводе выше). Он идемпотентен: после исправления запусти скрипт снова" ;;
  esac
}

app_setup_command() {
  local cmd
  cmd="$(wom_env_script)
cd $REMOTE_APP_DIR && bash scripts/provision/app-setup.sh --domain $(printf '%q' "$DOMAIN")"
  if [ -n "$REGISTRATION" ]; then cmd="$cmd --registration $(printf '%q' "$REGISTRATION")"; fi
  if [ -n "$ADMIN_USER" ]; then cmd="$cmd --admin-user $(printf '%q' "$ADMIN_USER")"; fi
  if [ -n "$ADMIN_EMAIL" ]; then cmd="$cmd --admin-email $(printf '%q' "$ADMIN_EMAIL")"; fi
  if [ -n "$CONTACT_URL" ]; then cmd="$cmd --contact-url $(printf '%q' "$CONTACT_URL")"; fi
  if [ -n "$TRUSTED_PROXY" ]; then cmd="$cmd --trusted-proxy $(printf '%q' "$TRUSTED_PROXY")"; fi
  if [ -n "$DUMP" ]; then cmd="$cmd --dump $REMOTE_DUMP"; fi
  if [ -n "$SMOKE" ]; then cmd="$cmd --smoke $(printf '%q' "$SMOKE")"; fi
  if [ "$HOSTWATCH" = 1 ]; then cmd="$cmd --hostwatch"; fi
  # --yes confirms the same things on the host (a changed domain of a configured platform), not only here
  if [ "$YES" = 1 ]; then cmd="$cmd --yes"; fi
  printf '%s' "$cmd"
}

upload_dump() {
  info "загружаю дамп на хост ($(basename "$DUMP")): он будет восстановлен до первого входа"
  rsh_stdin "$REMOTE_APP_USER" "umask 077; cat > $REMOTE_DUMP" < "$DUMP" \
    || die 1 "не удалось загрузить дамп на хост"
}

run_app_setup() {
  step "Установка платформы (app-setup.sh от пользователя $REMOTE_APP_USER)"
  if [ -n "$DUMP" ]; then upload_dump; fi
  local rc=0
  rsh "$REMOTE_APP_USER" "$(app_setup_command)" || rc=$?
  if [ "$rc" != 0 ]; then
    if [ -n "$DUMP" ]; then warn "дамп остался на хосте: $REMOTE_DUMP (права 600), удали его после разбора"; fi
    die 1 "app-setup.sh завершился с кодом $rc (причина в выводе выше, отчёт: ssh $(ssh_port_flag)$REMOTE_APP_USER@$HOST cat ~/install-report.txt). Он идемпотентен: после исправления запусти скрипт снова"
  fi
  if [ -n "$DUMP" ]; then rsh "$REMOTE_APP_USER" "rm -f $REMOTE_DUMP" || warn "не удалось удалить $REMOTE_DUMP на хосте, удали вручную"; fi
}

run_update() {
  step "Обновление (deploy.sh в режиме local)"
  local rc=0
  rsh "$REMOTE_APP_USER" "$(wom_env_script)
cd $REMOTE_APP_DIR && bash scripts/deploy.sh" || rc=$?
  [ "$rc" = 0 ] || die 1 "deploy.sh завершился с кодом $rc (причина в выводе выше; сообщения и что делать: docs/runbook-prod-install.md, §7)"
}

remote_domain() {
  local d
  d=$(rsh "$SSH_USER" "grep -m1 '^WOM_DOMAIN=' $REMOTE_APP_DIR/.env | cut -d= -f2-" 2>/dev/null || true)
  d=$(printf '%s' "$d" | tr -d "\"'\r " | tr 'A-Z' 'a-z')
  printf '%s' "$d"
}

check_health() {
  if ! command -v curl >/dev/null 2>&1; then warn "curl нет: проверку https://$DOMAIN/api/health пропускаю"; return 0; fi
  local tries=${WOM_HEALTH_TRIES:-30} pause=${WOM_HEALTH_SLEEP:-10} i=1 body="" insecure=()
  # no domain: the certificate is Caddy's own, this machine does not trust it
  if [ "$IP_MODE" = 1 ]; then insecure=(-k); fi
  while [ "$i" -le "$tries" ]; do
    if body=$(curl -fsS ${insecure[@]+"${insecure[@]}"} --ssl-no-revoke --max-time 20 "https://$DOMAIN/api/health" 2>/dev/null); then
      case "$body" in *'"ok":true'*) info "health: https://$DOMAIN/api/health отвечает ok"; return 0 ;; esac
    fi
    info "health: жду ответа https://$DOMAIN/api/health ($i/$tries)"
    if [ "$i" -lt "$tries" ]; then sleep "$pause"; fi
    i=$((i + 1))
  done
  return 1
}

print_summary() {
  local pflag
  pflag=$(ssh_port_flag)
  step "Готово"
  info "Адрес:           https://$DOMAIN"
  if [ "$IP_MODE" = 1 ]; then
    info "Сертификат:      самоподписанный (режим без домена): браузер предупредит, это ожидаемо. Чтобы получить настоящий, задай домен: --domain ДОМЕН --full --yes"
  fi
  if [ "$MODE" = update ]; then
    info "Режим:           обновление (host-setup и app-setup не запускались, .env не менялся)"
    info "Версия:          $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
    info "Отчёт установки: ssh ${pflag}$REMOTE_APP_USER@$HOST cat ~/install-report.txt"
    return 0
  fi
  info "Администратор:   ${ADMIN_USER:-admin}"
  info "Пароль:          не печатается; прочитай на хосте: ssh ${pflag}$REMOTE_APP_USER@$HOST cat ~/.wom-admin-password"
  info "Отчёт установки: ssh ${pflag}$REMOTE_APP_USER@$HOST cat ~/install-report.txt"
  info "Отчёт хоста:     ssh ${pflag}$SSH_USER@$HOST cat /root/wom-host-setup.report"
  info ""
  info "Что сделать вручную дальше:"
  info "  1. Копия бэкапов за пределы сервера: ночной дамп лежит в /srv/backups, забирай его с другой машины (rsync, cron), см. docs/runbook-prod-install.md, §6."
  info "  2. Уведомления в Telegram: TG_BOT_TOKEN и TG_CHAT_ID в ~/.wom-hostwatch.env на хосте (chmod 600); они нужны сторожу хоста и сообщению об упавшем юните."
  if [ -z "$CONTACT_URL" ]; then
    info "  3. CONTACT_URL не задан: без него нет ссылок «Написать нам». Впиши его в ~/wom-platform/.env и выполни docker compose up -d web."
  else
    info "  3. CONTACT_URL задан: проверь, что ссылка «Написать нам» открывается."
  fi
  info "  4. Проверь адрес клиента в логе Caddy (docker logs wom_caddy), см. docs/runbook-prod-install.md, §5."
}

# --- plan (--dry-run) ----------------------------------------------------------------------------------------------------
print_plan() {
  local pflag adopt="" a
  pflag=$(ssh_port_flag)
  if [ "$ADOPT" = 1 ]; then adopt=" --adopt"; fi
  step "План (--dry-run): ничего не будет сделано, ssh и сеть не используются"
  info "Хост:    $SSH_USER@$HOST (порт $PORT)${SSH_KEY:+, ключ $SSH_KEY}"
  info "Домен:   ${DOMAIN:-берётся из .env на хосте}"
  info "Дерево:  git archive HEAD ($(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"
  if [ "$UPDATE" = 1 ]; then
    info "Режим:   --update"
    info "  1. ssh ${pflag}$SSH_USER@$HOST: проверка доступа и ОС, наличия $REMOTE_APP_DIR/.env"
    info "  2. git archive HEAD | ssh ... tar -x -> $REMOTE_SRC"
    info "  3. rsync $REMOTE_SRC -> $REMOTE_APP_DIR (.env, .git и node_modules хоста не трогать), git add + commit от $REMOTE_APP_USER"
    info "  4. от $REMOTE_APP_USER: WOM_DEPLOY_MODE=local bash scripts/deploy.sh"
    info "  5. curl https://${DOMAIN:-<домен из .env>}/api/health с этой машины"
    return 0
  fi
  info "Режим:   полный путь (если на хосте уже есть $REMOTE_APP_DIR/.env, скрипт сам перейдёт в режим --update; --full заставляет идти полным путём)"
  info "  1. ssh ${pflag}$SSH_USER@$HOST: проверка доступа и ОС (Debian 13 или Ubuntu 24.04, root), наличия $REMOTE_APP_DIR/.env"
  if [ "$IP_MODE" = 1 ]; then
    info "  2. DNS-проверка не нужна: сайт по адресу $DOMAIN (самоподписанный сертификат Caddy)"
  elif [ "$SKIP_DNS" = 1 ]; then
    info "  2. DNS-проверка пропущена (--skip-dns-check)"
  else
    info "  2. DNS: getent ahostsv4 $DOMAIN на хосте должен дать адрес хоста"
  fi
  info "  3. git archive HEAD | ssh ... tar -x -> $REMOTE_SRC"
  info "  4. от root: bash scripts/provision/host-setup.sh$adopt"
  info "  5. rsync $REMOTE_SRC -> $REMOTE_APP_DIR, владелец $REMOTE_APP_USER, git init + commit от $REMOTE_APP_USER"
  if [ -n "$DUMP" ]; then info "  6. загрузка дампа $(basename "$DUMP") в $REMOTE_DUMP (права 600)"; else info "  6. дамп не задан"; fi
  a="--domain $DOMAIN"
  if [ -n "$REGISTRATION" ]; then a="$a --registration $REGISTRATION"; fi
  if [ -n "$ADMIN_USER" ]; then a="$a --admin-user $ADMIN_USER"; fi
  if [ -n "$ADMIN_EMAIL" ]; then a="$a --admin-email $ADMIN_EMAIL"; fi
  if [ -n "$CONTACT_URL" ]; then a="$a --contact-url $CONTACT_URL"; fi
  if [ -n "$TRUSTED_PROXY" ]; then a="$a --trusted-proxy $TRUSTED_PROXY"; fi
  if [ -n "$DUMP" ]; then a="$a --dump $REMOTE_DUMP"; fi
  if [ -n "$SMOKE" ]; then a="$a --smoke $SMOKE"; fi
  if [ "$HOSTWATCH" = 1 ]; then a="$a --hostwatch"; fi
  info "  7. от $REMOTE_APP_USER (ssh ${pflag}$REMOTE_APP_USER@$HOST): bash scripts/provision/app-setup.sh $a"
  if [ "$IP_MODE" = 1 ]; then
    info "  8. curl -k https://$DOMAIN/api/health с этой машины (сертификат самоподписанный)"
  else
    info "  8. curl https://$DOMAIN/api/health с этой машины (до 5 минут: Caddy получает сертификат)"
  fi
  info "  9. сводка: адрес, логин администратора, команда чтения пароля, что сделать вручную"
}

# --- main --------------------------------------------------------------------------------------------------------------
main() {
  parse_args "$@"
  if [ "$SHOW_HELP" = 1 ]; then usage; return 0; fi
  validate_args
  locate_repo
  build_ssh_opts

  if [ "$IP_MODE" = 1 ]; then info "Game of Incidents: подготовка хоста $HOST (сайт по адресу https://$DOMAIN, без домена)"; else info "Game of Incidents: подготовка хоста $HOST${DOMAIN:+ под домен $DOMAIN}"; fi

  if [ "$UPDATE" = 1 ]; then MODE=update; else MODE=full; fi
  check_local

  if [ "$DRY_RUN" = 1 ]; then
    print_plan
    return 0
  fi

  step "Предпроверки"
  check_ssh
  check_host_os

  if host_has_env; then
    if [ -n "$DUMP" ]; then
      die 2 "--dump применим только при первой установке: на $HOST уже есть $REMOTE_APP_DIR/.env, а восстановление дампа стирает базу работающей платформы. Для неё есть ручная процедура (docs/runbook-prod-install.md, «Восстановление из дампа»)"
    fi
    if [ "$UPDATE" = 1 ]; then
      MODE=update
      warn "платформа на хосте уже работает ($REMOTE_APP_DIR/.env есть): обновление перезапустит web и orchestrator, активные сессии это переживают"
    elif [ "$FULL" = 1 ]; then
      MODE=full
      confirm "На хосте $HOST уже есть работающая платформа. Полный путь повторит host-setup и app-setup (секреты в .env не перезаписываются)."
    else
      MODE=update
      info "на хосте уже есть $REMOTE_APP_DIR/.env: работаю как --update (доставка кода и deploy.sh); полный путь включается флагом --full"
      confirm "Обновить работающую платформу на $HOST? Деплой перезапустит web и orchestrator, активные сессии это переживают."
    fi
  else
    if [ "$UPDATE" = 1 ]; then die 2 "на хосте нет $REMOTE_APP_DIR/.env: платформа не установлена, --update не применим. Запусти без --update"; fi
    MODE=full
  fi

  if [ "$MODE" = update ]; then
    if [ -n "$ADMIN_USER$ADMIN_EMAIL$REGISTRATION$CONTACT_URL$SMOKE" ] || [ "$HOSTWATCH" = 1 ]; then
      warn "параметры платформы (--admin-user, --admin-email, --registration, --contact-url, --smoke, --hostwatch) при обновлении игнорируются: .env не меняется"
    fi
    local rdom
    rdom=$(remote_domain)
    if [ -z "$DOMAIN" ]; then
      [ -n "$rdom" ] || die 2 "не указан --domain, а WOM_DOMAIN в $REMOTE_APP_DIR/.env прочитать не удалось"
      valid_site "$rdom" || die 2 "WOM_DOMAIN в .env на хосте ('$rdom') не похож на домен: укажи --domain"
      DOMAIN=$rdom
      if is_ipv4 "$DOMAIN"; then IP_MODE=1; fi
    elif [ -n "$rdom" ] && [ "$rdom" != "$DOMAIN" ]; then
      warn "в .env на хосте WOM_DOMAIN=$rdom, а ты указал $DOMAIN; обновление .env не меняет, проверка пойдёт по $DOMAIN"
    fi
  else
    if [ "$IP_MODE" = 1 ]; then
      warn "режим без домена: сайт будет по https://$DOMAIN с самоподписанным сертификатом Caddy (браузер покажет предупреждение). Домен можно задать позже повторным запуском с --domain и --full"
    elif [ "$SKIP_DNS" = 1 ]; then
      warn "DNS-проверка отключена флагом --skip-dns-check"
    else
      check_dns
    fi
    confirm "Настроить хост $HOST (пакеты, пользователь $REMOTE_APP_USER, том под Docker, фаервол, ssh) и поставить платформу на $DOMAIN."
  fi

  step "Доставка кода"
  deliver_tree

  if [ "$MODE" = update ]; then
    sync_to_app_dir
    run_update
  else
    run_host_setup
    sync_to_app_dir
    run_app_setup
  fi

  step "Проверка снаружи"
  if ! check_health; then
    die 1 "платформа поднята на хосте, но https://$DOMAIN/api/health с этой машины не отвечает ok. Проверь: A-запись $DOMAIN указывает на $HOST, порты 80 и 443 открыты у провайдера, сертификат (docker logs wom_caddy на хосте). Отчёт: ssh $(ssh_port_flag)$REMOTE_APP_USER@$HOST cat ~/install-report.txt"
  fi
  print_summary
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
