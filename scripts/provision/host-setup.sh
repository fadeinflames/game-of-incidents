#!/usr/bin/env bash
# Game of Incidents: preparing a bare Debian 13 host (zone A of the one-command install, docs/runbook-prod-install.md).
# Runs AS ROOT ON THE HOST (scripts/provision/provision.sh delivers the tree and calls it). Idempotent: a second run only
# repairs what drifted. Nothing here prints or stores a secret.
#
# What it does: checks the machine, installs packages (+ Docker CE rootless-extras, Node 22), creates the service user
# without sudo, copies root's ssh keys to it, sets subuid/subgid, linger, sysctl, an xfs(pquota) loop volume for the
# Docker data-root, directories, ufw, ssh hardening (only when root has a key), unattended-upgrades, rootless dockerd of
# the user (slirp4netns port driver, daemon.json), kind; checks cgroup delegation; writes /root/wom-host-setup.report.
#
# Usage:  host-setup.sh [--user wom] [--data-root /srv/docker] [--docker-img /srv/images/docker.img] [--docker-img-gb 150]
#                       [--backups-dir /srv/backups] [--pgdata-dir /srv/pgdata] [--no-firewall] [--no-harden-ssh]
#                       [--adopt] [--dry-run]
# Exit codes: 0 ok; 1 a step failed; 2 environment check failed (not root / not Debian 13 or Ubuntu 24.04 / too small); 3 the data-root
# (or its fstab entry, or a running system Docker) holds someone else's data and --adopt was not given; 64 bad arguments.
# Test hooks: the file is meant to be `source`d (main runs only when it is executed); WOM_FS_ROOT prefixes the config
# files it writes (tests); every probe is a small function that a test can redefine.
set -euo pipefail

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd)
REPO_ROOT=${WOM_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}

# ---- settings (overridden by the arguments) ----
USER_NAME=wom
DATA_ROOT=/srv/docker
DOCKER_IMG=/srv/images/docker.img
DOCKER_IMG_GB=""   # empty: sized from the free space (up to 150 GB), see size_docker_img
BACKUPS_DIR=/srv/backups
PGDATA_DIR=/srv/pgdata
FIREWALL=1
HARDEN_SSH=1
ADOPT=0
DRY_RUN=0

FS_ROOT=${WOM_FS_ROOT:-}
KIND_VERSION_FALLBACK=v0.33.0
NODE_MAJOR=${WOM_NODE_MAJOR:-22}
MIN_CPUS=2
MIN_RAM_KB=7300000                  # "8 GB" with the allowance for memory the kernel and firmware keep for themselves
MIN_FREE_KB=$((40 * 1024 * 1024))   # 40 GiB
REC_CPUS=8
REC_RAM_GB=32
DOCKER_GPG_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
WAIT_SLEEP=${WAIT_SLEEP:-1}

# the packages of runbook section 2 plus what the rest of the install needs (jq: daemon.json; openssl: secrets of app-setup;
# iptables: dockerd-rootless-setuptool.sh refuses to run without it; util-linux: mount/losetup/runuser/flock;
# libpam-systemd: a user manager for ssh sessions; make: the runbook's `make clean-sandboxes`). No sudo on purpose.
APT_PACKAGES=(ufw unattended-upgrades curl git ca-certificates gnupg uidmap dbus-user-session libpam-systemd slirp4netns
  fuse-overlayfs xfsprogs rsync jq openssl iptables util-linux make)
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras)

WORK=""
WARNINGS=()
FAILURES=()
PUT_CHANGED=0
DATA_ROOT_MODE=""      # loop (our xfs image mounted on the data-root) | adopt (the directory is used as it is)
SSH_STATE="не менялся"
NODE_INSTALLED_NOW=0
DOCKER_INFO=""
KIND_VERSION=""
KEYS_ADDED=0

# ---- output ----
log()  { printf 'host-setup: %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
plan() { printf '  [план] %s\n' "$*"; }
warn() { printf 'host-setup: ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; WARNINGS+=("$*"); }
die()  { printf 'host-setup: ОШИБКА: %s\n' "$*" >&2; exit 1; }
die_usage()   { printf 'host-setup: %s\nПодсказка: host-setup.sh --help\n' "$*" >&2; exit 64; }
die_env()     { printf 'host-setup: окружение не подходит, ничего не изменено:\n%s\n' "$*" >&2; exit 2; }
die_foreign() { printf 'host-setup: %s\n' "$*" >&2; exit 3; }

usage() {
  cat <<'USAGE'
Использование: host-setup.sh [параметры]   (запускать от root на хосте с Debian 13 или Ubuntu 24.04)

  --user NAME            сервисный пользователь платформы, без sudo (wom)
  --data-root DIR        data-root rootless Docker, на нём xfs-том (/srv/docker)
  --docker-img FILE      loop-файл с xfs и pquota под data-root (/srv/images/docker.img)
  --docker-img-gb N      размер файла в ГБ, разреженный (150)
  --backups-dir DIR      каталог дампов, права 700 (/srv/backups)
  --pgdata-dir DIR       каталог данных PostgreSQL (/srv/pgdata)
  --no-firewall          не трогать ufw
  --no-harden-ssh        не ужесточать sshd (по умолчанию ужесточается только если у root есть ключ)
  --adopt                взять существующий непустой data-root как есть: без образа и без записи в fstab
  --dry-run              ничего не менять, только напечатать план
  -h, --help             эта справка

Коды выхода: 0 успех; 1 шаг не удался; 2 окружение не подходит (не root, не Debian 13, мало ресурсов);
3 в data-root чужие данные и нет --adopt; 64 неверные аргументы.
Минимум: 4 CPU, 8 ГБ RAM, 60 ГБ свободного места; рекомендуется 8 CPU и 32 ГБ RAM.
USAGE
}

# ---- argument parsing ----
valid_abs_path() { [[ $1 =~ ^/[A-Za-z0-9._/@+-]+$ ]] && [[ $1 != *..* ]]; }

parse_args() {
  local a v
  while [ $# -gt 0 ]; do
    a=$1
    case $a in
      --user|--data-root|--docker-img|--docker-img-gb|--backups-dir|--pgdata-dir)
        [ $# -ge 2 ] || die_usage "параметру $a нужно значение"
        v=$2; shift 2 ;;
      --user=*|--data-root=*|--docker-img=*|--docker-img-gb=*|--backups-dir=*|--pgdata-dir=*)
        v=${a#*=}; a=${a%%=*}; shift ;;
      --no-firewall)   FIREWALL=0; shift; continue ;;
      --no-harden-ssh) HARDEN_SSH=0; shift; continue ;;
      --adopt)         ADOPT=1; shift; continue ;;
      --dry-run)       DRY_RUN=1; shift; continue ;;
      -h|--help)       usage; exit 0 ;;
      *) die_usage "неизвестный параметр: $a" ;;
    esac
    case $a in
      --user) USER_NAME=$v ;;
      --data-root) DATA_ROOT=$v ;;
      --docker-img) DOCKER_IMG=$v ;;
      --docker-img-gb) DOCKER_IMG_GB=$v ;;
      --backups-dir) BACKUPS_DIR=$v ;;
      --pgdata-dir) PGDATA_DIR=$v ;;
    esac
  done
  validate_args
}

validate_args() {
  local p
  [[ $USER_NAME =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die_usage "недопустимое имя пользователя: '$USER_NAME'"
  [ "$USER_NAME" != root ] || die_usage "сервисный пользователь не может быть root"
  [ -z "$DOCKER_IMG_GB" ] || { [[ $DOCKER_IMG_GB =~ ^[0-9]+$ ]] && [ "$DOCKER_IMG_GB" -ge 20 ]; } || die_usage "--docker-img-gb: целое число не меньше 20, получено '$DOCKER_IMG_GB'"
  for p in DATA_ROOT DOCKER_IMG BACKUPS_DIR PGDATA_DIR; do
    # trailing slashes are dropped so that comparisons and fstab lines are stable
    while [ "${!p}" != / ] && [ "${!p%/}" != "${!p}" ]; do printf -v "$p" '%s' "${!p%/}"; done
    valid_abs_path "${!p}" || die_usage "путь должен быть абсолютным, без пробелов и '..': ${!p}"
  done
  case "$DOCKER_IMG" in "$DATA_ROOT"/*) die_usage "--docker-img не может лежать внутри --data-root: файл лежал бы на собственном томе" ;; esac
  case "$BACKUPS_DIR" in "$DATA_ROOT"|"$DATA_ROOT"/*) die_usage "--backups-dir не может лежать внутри --data-root" ;; esac
  case "$PGDATA_DIR" in "$DATA_ROOT"|"$DATA_ROOT"/*) die_usage "--pgdata-dir не может лежать внутри --data-root: база не должна делить том с песочницами" ;; esac
  if [ "$BACKUPS_DIR" = "$PGDATA_DIR" ]; then die_usage "--backups-dir и --pgdata-dir должны различаться"; fi
}

# ---- probes (small on purpose: tests redefine them) ----
get_uid()       { id -u; }
get_nproc()     { nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; }
get_mem_kb()    { awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo; }
get_arch()      { uname -m; }
cgroup_fstype() { stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown; }
systemd_present() { [ -d /run/systemd/system ]; }
nearest_existing() { local p=$1; while [ ! -e "$p" ] && [ "$p" != / ]; do p=$(dirname "$p"); done; printf '%s' "$p"; }
get_free_kb()   { df -Pk "$(nearest_existing "$1")" | awk 'NR==2 {print $4}'; }
os_release_file() { printf '%s/etc/os-release' "$FS_ROOT"; }
os_field() { # KEY -> value of KEY in os-release without quotes (the file is never sourced)
  [ -r "$(os_release_file)" ] || return 0
  sed -n "s/^$1=//p" "$(os_release_file)" | head -n1 | tr -d "\"'"
}
is_mountpoint() { command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$1"; }
mount_source()  { findmnt -no SOURCE "$1" 2>/dev/null || true; }
mount_options() { findmnt -no OPTIONS "$1" 2>/dev/null || true; }
mount_fstype()  { findmnt -no FSTYPE "$1" 2>/dev/null || true; }
is_loop_of_img() { # LOOP_DEVICE: is it the loop device of our image
  local names; command -v losetup >/dev/null 2>&1 || return 1
  names=$(losetup -j "$DOCKER_IMG" -n -O NAME 2>/dev/null || true)
  case $'\n'"$names"$'\n' in *$'\n'"$1"$'\n'*) return 0 ;; *) return 1 ;; esac
}
image_fs_type() { command -v blkid >/dev/null 2>&1 || return 0; blkid -p -s TYPE -o value "$1" 2>/dev/null || true; }
image_used_kb() { du -k "$1" 2>/dev/null | awk '{print $1; exit}'; }
dir_has_entries() { [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit 2>/dev/null)" ]; }
user_exists()   { id "$USER_NAME" >/dev/null 2>&1; }
user_uid()      { id -u "$USER_NAME" 2>/dev/null || true; }
user_home()     { local h; h=$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f6 || true); printf '%s' "${h:-/home/$USER_NAME}"; }
user_groups()   { id -nG "$USER_NAME" 2>/dev/null || true; }
pkg_installed() { [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true)" = installed ]; }
fstab_path()    { printf '%s/etc/fstab' "$FS_ROOT"; }
fstab_source_for() { # MOUNTPOINT -> source field of its active fstab line, empty when there is none
  [ -f "$(fstab_path)" ] || return 0
  awk -v mp="$1" '$0 !~ /^[[:space:]]*#/ && $2 == mp {print $1; exit}' "$(fstab_path)"
}
has_valid_key_line() { # FILE: at least one real public key line (comments and blanks do not count)
  [ -s "$1" ] || return 1
  grep -Ev '^[[:space:]]*(#|$)' "$1" |
    grep -E '(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[[:space:]]+[A-Za-z0-9+/=]{20,}' >/dev/null
}
wait_for() { # DESCRIPTION TIMEOUT_SEC COMMAND... : poll until the command succeeds
  local what=$1 timeout=$2 started=$SECONDS; shift 2
  until "$@" >/dev/null 2>&1; do
    if [ $((SECONDS - started)) -ge "$timeout" ]; then return 1; fi
    sleep "$WAIT_SLEEP"
  done
}

# ---- doing things ----
quote_cmd() { printf '%q ' "$@"; }
run() { # a destructive command: printed instead of executed under --dry-run
  if [ "$DRY_RUN" = 1 ]; then plan "$(quote_cmd "$@")"; return 0; fi
  "$@"
}
ensure_work() { if [ -z "$WORK" ]; then WORK=$(mktemp -d); fi; }
cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi; }

# put_file PATH MODE OWNER:GROUP  (content on stdin). Sets PUT_CHANGED=1 when the content differs (never returns non-zero).
put_file() {
  local path=$1 mode=$2 owner=$3 tmp cur_mode
  ensure_work
  tmp=$(mktemp "$WORK/put.XXXXXX"); cat > "$tmp"
  PUT_CHANGED=0
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    cur_mode=$(stat -c %a "$path" 2>/dev/null || echo "$mode")
    if [ "$cur_mode" != "$mode" ]; then run chmod "$mode" "$path"; fi
    log "без изменений: $path"
    rm -f "$tmp"; return 0
  fi
  PUT_CHANGED=1
  if [ "$DRY_RUN" = 1 ]; then plan "записать $path (режим $mode, владелец $owner)"; rm -f "$tmp"; return 0; fi
  mkdir -p "$(dirname "$path")"
  install -m "$mode" "$tmp" "$path"
  if [ "$owner" != root:root ]; then chown "$owner" "$path"; fi
  rm -f "$tmp"
  log "записал: $path"
}

# ensure_dir PATH MODE OWNER:GROUP [FIX=1]: create; with FIX=1 also repair mode and owner of the directory itself (never
# recursive); with FIX=2 repair only when the owner differs (a directory already owned by the right user keeps its mode).
# A symlink is refused: chown/chmod would follow it, and directories under the service user's home are writable by that user.
ensure_dir() {
  local path=$1 mode=$2 owner=$3 fix=${4:-1} cur_mode cur_owner
  if [ -L "$path" ] && [ "$(stat -c %U "$path" 2>/dev/null || echo ?)" != root ]; then
    die "$path является символической ссылкой не от root: root не будет менять права по ссылке (убери её или создай каталог сам)"
  fi
  if [ ! -d "$path" ]; then
    run install -d -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$path"
    return 0
  fi
  if [ "$fix" = 0 ]; then return 0; fi
  cur_mode=$(stat -c %a "$path"); cur_owner=$(stat -c %U:%G "$path")
  if [ "$fix" = 2 ] && [ "$cur_owner" = "$owner" ]; then return 0; fi
  if [ "$cur_mode" != "$mode" ]; then run chmod "$mode" "$path"; fi
  if [ "$cur_owner" != "$owner" ]; then run chown "$owner" "$path"; fi
}
user_mkdir() { # RELATIVE_PATH: create the directories under the user's home owned by the user; existing ones are left alone
  local cur part; local -a parts
  cur=$(user_home)
  IFS=/ read -r -a parts <<< "$1"
  for part in "${parts[@]}"; do
    cur="$cur/$part"
    ensure_dir "$cur" 755 "$USER_NAME:$USER_NAME" 0
  done
}

# as_user COMMAND...: run as the service user with a clean environment that has a working systemd --user and its D-Bus
as_user() {
  local home uid; home=$(user_home); uid=$(user_uid); uid=${uid:-0}
  ( cd "$home" && runuser -u "$USER_NAME" -- env -i HOME="$home" USER="$USER_NAME" LOGNAME="$USER_NAME" \
      PATH="$home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@" )
}
as_user_docker() { local uid; uid=$(user_uid); uid=${uid:-0}; as_user env DOCKER_HOST="unix:///run/user/$uid/docker.sock" "$@"; }

# ---- checks ----
check_env() {
  local -a problems=()
  local uid cpus mem os_id os_ver codename arch
  uid=$(get_uid)
  if [ "$uid" != 0 ]; then problems+=("  - запусти от root (сейчас uid $uid): ssh root@хост, затем bash host-setup.sh"); fi
  os_id=$(os_field ID); os_ver=$(os_field VERSION_ID); codename=$(os_field VERSION_CODENAME)
  case "$os_id:$os_ver:$codename" in
    debian:13:*|debian:*:trixie|ubuntu:24.04:*) ;;
    *) problems+=("  - нужен Debian 13 (trixie) или Ubuntu 24.04 LTS, найдено: ${os_id:-неизвестно} ${os_ver:-?}") ;;
  esac
  arch=$(get_arch)
  if [ "$arch" != x86_64 ]; then problems+=("  - нужна архитектура x86_64 (kind и образы собраны под amd64), найдено: $arch"); fi
  if [ "$(cgroup_fstype)" != cgroup2fs ]; then problems+=("  - нужен cgroup v2 (unified): на cgroup v1 лимиты rootless Docker не работают"); fi
  if ! systemd_present; then problems+=("  - не найден запущенный systemd (/run/systemd/system): нужен для linger и пользовательских юнитов"); fi
  cpus=$(get_nproc); mem=$(get_mem_kb)
  if [ "${cpus:-0}" -lt "$MIN_CPUS" ]; then problems+=("  - мало CPU: $cpus, минимум $MIN_CPUS (рекомендуется $REC_CPUS)"); fi
  if [ "${mem:-0}" -lt "$MIN_RAM_KB" ]; then
    problems+=("  - мало памяти: $(( ${mem:-0} / 1024 / 1024 )) ГБ, минимум 8 ГБ (рекомендуется $REC_RAM_GB ГБ)")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    die_env "$(printf '%s\n' "${problems[@]}")
Требования: Debian 13 или Ubuntu 24.04 LTS, root, минимум $MIN_CPUS CPU, 8 ГБ RAM и 40 ГБ свободного места; рекомендуется $REC_CPUS CPU и $REC_RAM_GB ГБ RAM."
  fi
  if [ "$cpus" -lt "$REC_CPUS" ] || [ "${mem:-0}" -lt $((REC_RAM_GB * 1024 * 1024 * 9 / 10)) ]; then
    warn "ресурсов меньше рекомендованных ($REC_CPUS CPU, $REC_RAM_GB ГБ RAM): app-setup.sh выберет для .env уменьшенный профиль ёмкости (меньше одновременных сессий и кластеров, ноды kind меньше)"
  fi
  if [ ! -e /dev/kvm ]; then log "заметка: /dev/kvm нет, для текущей версии платформы не нужен (нужен для будущего Firecracker)"; fi
}

# a running system-wide Docker with containers is someone else's workload: disabling it (step "Docker") would stop them
check_system_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  if systemctl is-active --quiet docker.service 2>/dev/null && [ -n "$(docker ps -q 2>/dev/null || true)" ]; then
    die_foreign "на хосте работает системный Docker с запущенными контейнерами, а шаг установки отключает системный демон (нужен только rootless). Останови их сам и запусти скрипт снова."
  fi
}

decide_data_root_mode() {
  local fsrc msrc="" mounted=0 nonempty=0 itype
  fsrc=$(fstab_source_for "$DATA_ROOT")
  if is_mountpoint "$DATA_ROOT"; then mounted=1; msrc=$(mount_source "$DATA_ROOT"); fi
  if dir_has_entries "$DATA_ROOT"; then nonempty=1; fi

  if [ -n "$fsrc" ] && [ "$fsrc" = "$DOCKER_IMG" ]; then
    DATA_ROOT_MODE=loop
  elif [ "$mounted" = 1 ] && [ -n "$msrc" ] && is_loop_of_img "$msrc"; then
    DATA_ROOT_MODE=loop
  elif [ -n "$fsrc" ]; then
    if [ "$ADOPT" != 1 ]; then
      die_foreign "в /etc/fstab для $DATA_ROOT уже есть чужая запись (источник $fsrc). Скрипт её не трогает. Если это нужный том, запусти с --adopt; иначе освободи путь."
    fi
    DATA_ROOT_MODE=adopt
  elif [ "$mounted" = 1 ]; then
    if [ "$nonempty" = 1 ] && [ "$ADOPT" != 1 ]; then
      die_foreign "$DATA_ROOT смонтирован ($msrc) и содержит чужие данные. Запусти с --adopt, чтобы использовать том как есть."
    fi
    DATA_ROOT_MODE=adopt
  elif [ "$nonempty" = 1 ]; then
    if [ "$ADOPT" != 1 ]; then
      die_foreign "$DATA_ROOT не пуст и не смонтирован как наш том: скрипт не будет монтировать образ поверх чужих данных. Перенеси их или запусти с --adopt (каталог будет использован как есть, без образа и без записи в fstab)."
    fi
    DATA_ROOT_MODE=adopt
  else
    DATA_ROOT_MODE=loop
  fi

  if [ "$DATA_ROOT_MODE" = loop ] && [ -f "$DOCKER_IMG" ]; then
    itype=$(image_fs_type "$DOCKER_IMG")
    if [ -n "$itype" ] && [ "$itype" != xfs ]; then
      die_foreign "$DOCKER_IMG уже существует и содержит файловую систему '$itype', а не xfs: скрипт не будет её форматировать."
    fi
  fi
  log "data-root $DATA_ROOT: режим $DATA_ROOT_MODE"
}

check_disk() {
  local free
  if [ "$DATA_ROOT_MODE" != loop ] || [ -f "$DOCKER_IMG" ]; then
    [ -n "$DOCKER_IMG_GB" ] || DOCKER_IMG_GB=150
    return 0
  fi
  free=$(get_free_kb "$(dirname "$DOCKER_IMG")")
  if [ "${free:-0}" -lt "$MIN_FREE_KB" ]; then
    die_env "  - мало свободного места для $(dirname "$DOCKER_IMG"): $(( ${free:-0} / 1024 / 1024 )) ГБ, минимум 40 ГБ"
  fi
  # the image is sparse, but a declared size the disk cannot hold only moves the "disk full" from the sandboxes to the
  # whole system: leave 12 GB for the OS, backups and PostgreSQL, never more than 150 GB, never less than 20 GB
  if [ -z "$DOCKER_IMG_GB" ]; then
    DOCKER_IMG_GB=$(( free / 1024 / 1024 - 12 ))
    [ "$DOCKER_IMG_GB" -le 150 ] || DOCKER_IMG_GB=150
    [ "$DOCKER_IMG_GB" -ge 20 ] || DOCKER_IMG_GB=20
    log "образ под data-root Docker: $DOCKER_IMG_GB ГБ (по свободному месту $(( free / 1024 / 1024 )) ГБ)"
  fi
  if [ "$free" -lt $((DOCKER_IMG_GB * 1024 * 1024)) ]; then
    warn "свободно $(( free / 1024 / 1024 )) ГБ, а образ Docker объявлен на $DOCKER_IMG_GB ГБ (он разреженный и растёт по мере записи): следи за заполнением корня (hostwatch)"
  fi
}

# ---- steps ----
step_packages() {
  step "Пакеты"
  local -a missing=(); local p
  for p in "${APT_PACKAGES[@]}"; do
    if ! pkg_installed "$p"; then missing+=("$p"); fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then log "все пакеты уже установлены"; return 0; fi
  log "ставлю: ${missing[*]}"
  run env DEBIAN_FRONTEND=noninteractive apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q -o Dpkg::Options::=--force-confold "${missing[@]}"
}

# install_keyring URL DEST [FINGERPRINT]: download an armored key, check the fingerprint when given, store it dearmored
install_keyring() {
  local url=$1 dest=$2 fpr=${3:-} raw bin
  ensure_work
  raw=$WORK/key.asc; bin=$WORK/key.gpg
  curl -fsSL --retry 3 --connect-timeout 15 -o "$raw" "$url" || die "не скачался ключ $url"
  if [ -n "$fpr" ]; then
    if ! gpg --show-keys --with-colons "$raw" 2>/dev/null | awk -F: '$1 == "fpr" {print $10}' | grep -x "$fpr" >/dev/null; then
      die "отпечаток ключа $url не совпал с ожидаемым $fpr: репозиторий не подключаю"
    fi
  fi
  gpg --dearmor --yes -o "$bin" "$raw" 2>/dev/null || die "не разобрался ключ $url"
  install -d -m 0755 "$(dirname "$dest")"
  if [ -f "$dest" ] && cmp -s "$bin" "$dest"; then return 0; fi
  install -m 0644 "$bin" "$dest"
}

step_node() {
  step "Node.js $NODE_MAJOR (нужен хосту для CLI wom, npm ci и сида)"
  local cur=0
  if command -v node >/dev/null 2>&1; then cur=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0); fi
  if [ "$cur" -ge "$NODE_MAJOR" ]; then log "node $cur уже есть"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then
    plan "добавить репозиторий NodeSource node_$NODE_MAJOR.x (ключ в /etc/apt/keyrings/nodesource.gpg) и поставить nodejs"
    return 0
  fi
  install_keyring https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /etc/apt/keyrings/nodesource.gpg
  put_file "$FS_ROOT/etc/apt/sources.list.d/nodesource.list" 644 root:root <<EOF
deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
  NODE_INSTALLED_NOW=1
}

step_user() {
  step "Пользователь $USER_NAME (без sudo)"
  local g shell
  if user_exists; then
    if [ "$(user_uid)" = 0 ]; then die "пользователь $USER_NAME имеет uid 0"; fi
    log "пользователь $USER_NAME уже есть"
    shell=$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f7 || true)
    case $shell in */nologin|*/false) run usermod -s /bin/bash "$USER_NAME" ;; esac
  else
    run useradd -m -s /bin/bash "$USER_NAME"
  fi
  # the threat model: the service user must not be root-equivalent
  for g in sudo admin docker; do
    case " $(user_groups) " in
      *" $g "*)
        log "убираю $USER_NAME из группы $g (она равна root)"
        run gpasswd -d "$USER_NAME" "$g" ;;
    esac
  done
  if [ -e "$FS_ROOT/etc/sudoers.d/$USER_NAME" ]; then
    log "удаляю /etc/sudoers.d/$USER_NAME"
    run rm -f "$FS_ROOT/etc/sudoers.d/$USER_NAME"
  fi
}

# merge_authorized_keys SRC DST OWNER: append the key lines of SRC that DST lacks; sets KEYS_ADDED
merge_authorized_keys() {
  local src=$1 dst=$2 line
  KEYS_ADDED=0
  ensure_work
  local add=$WORK/keys.add; : > "$add"
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in ''|'#'*) continue ;; esac
    case $line in
      command=*|*' command='*|*,command=*) warn "ключ root с ограничением command=: у $USER_NAME он тоже будет ограничен, и ssh $USER_NAME@хост не заработает (поправь $dst)" ;;
    esac
    if [ -f "$dst" ] && grep -qxF -- "$line" "$dst"; then continue; fi
    printf '%s\n' "$line" >> "$add"; KEYS_ADDED=$((KEYS_ADDED + 1))
  done < "$src"
  if [ "$KEYS_ADDED" -eq 0 ]; then return 0; fi
  if [ "$DRY_RUN" = 1 ]; then plan "добавить $KEYS_ADDED ключ(ей) в $dst"; return 0; fi
  if [ -s "$dst" ] && [ -n "$(tail -c1 "$dst")" ]; then printf '\n' >> "$dst"; fi
  cat "$add" >> "$dst"
}

step_authorized_keys() {
  step "SSH-ключи пользователя $USER_NAME"
  local src="$FS_ROOT/root/.ssh/authorized_keys" home dst
  home=$(user_home); dst="$home/.ssh/authorized_keys"
  if ! has_valid_key_line "$src"; then
    warn "у root нет ssh-ключей: пользователю $USER_NAME нечего копировать. Сделай ssh-copy-id под root и запусти скрипт снова (вход по паролю останется включённым)."
    return 0
  fi
  ensure_dir "$home/.ssh" 700 "$USER_NAME:$USER_NAME"
  merge_authorized_keys "$src" "$dst"
  if [ "$DRY_RUN" != 1 ]; then
    chmod 600 "$dst"; chown "$USER_NAME:$USER_NAME" "$dst"
    log "authorized_keys пользователя $USER_NAME: добавлено ключей $KEYS_ADDED"
  fi
}

next_subid_start() { # FILE: first free start for a 65536-wide range (100000 when the file is empty)
  local end=0 e
  if [ -s "$1" ]; then
    e=$(awk -F: 'NF >= 3 {s = $2 + $3; if (s > m) m = s} END {print m + 0}' "$1")
    end=$e
  fi
  if [ "$end" -lt 100000 ]; then end=100000; fi
  printf '%s' "$end"
}

step_subids() {
  step "subuid/subgid"
  local f start
  for f in subuid subgid; do
    if grep -q "^$USER_NAME:" "$FS_ROOT/etc/$f" 2>/dev/null; then log "$f: запись для $USER_NAME есть"; continue; fi
    start=$(next_subid_start "$FS_ROOT/etc/$f")
    if [ "$f" = subuid ]; then run usermod --add-subuids "$start-$((start + 65535))" "$USER_NAME"
    else run usermod --add-subgids "$start-$((start + 65535))" "$USER_NAME"; fi
  done
}

step_linger() {
  step "linger и менеджер пользователя"
  local uid
  if [ ! -e "$FS_ROOT/var/lib/systemd/linger/$USER_NAME" ]; then run loginctl enable-linger "$USER_NAME"; fi
  uid=$(user_uid)
  if [ "$DRY_RUN" = 1 ]; then plan "systemctl start user@<uid>.service и дождаться /run/user/<uid>/bus"; return 0; fi
  systemctl start "user@$uid.service"
  wait_for "шина пользователя" 60 test -S "/run/user/$uid/bus" || die "менеджер systemd пользователя $USER_NAME не поднялся за 60 с (нет /run/user/$uid/bus)"
  log "менеджер пользователя работает (uid $uid)"
}

step_modules_sysctl() {
  step "Модули ядра и sysctl"
  local m f
  put_file "$FS_ROOT/etc/modules-load.d/90-wom.conf" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: kind in rootless Docker needs these (kind.sigs.k8s.io rootless guide); loop backs the data-root image
ip6_tables
ip6table_nat
ip_tables
iptable_nat
loop
EOF
  for m in ip6_tables ip6table_nat ip_tables iptable_nat loop; do
    if [ "$DRY_RUN" = 1 ]; then continue; fi
    modprobe -q "$m" 2>/dev/null || warn "модуль ядра $m не загрузился (в контейнере или без модулей это нормально)"
  done
  put_file "$FS_ROOT/etc/sysctl.d/90-wom.conf" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: rootless Docker must bind 80/443 (Caddy)
net.ipv4.ip_unprivileged_port_start=80
EOF
  put_file "$FS_ROOT/etc/sysctl.d/90-wom-keyring.conf" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: runc makes a session key per container; the default 200 per uid runs out at ~6 kind clusters
kernel.keys.maxkeys = 20000
kernel.keys.maxbytes = 400000
EOF
  put_file "$FS_ROOT/etc/sysctl.d/91-wom-inotify.conf" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: several kind clusters exhaust the default 128 inotify instances
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 1048576
EOF
  for f in 90-wom.conf 90-wom-keyring.conf 91-wom-inotify.conf; do
    if [ "$DRY_RUN" = 1 ]; then plan "sysctl -q -p /etc/sysctl.d/$f"; continue; fi
    sysctl -q -p "$FS_ROOT/etc/sysctl.d/$f" >/dev/null 2>&1 || warn "sysctl не применил /etc/sysctl.d/$f сразу (подействует после перезагрузки)"
  done
}

# fstab_ensure_entry: our loop line, appended once; the old file is kept as fstab.wom-backup-<time>
fstab_ensure_entry() {
  local fstab line src stamp new
  fstab=$(fstab_path); line="$DOCKER_IMG $DATA_ROOT xfs loop,noatime,pquota,nofail 0 0"
  src=$(fstab_source_for "$DATA_ROOT")
  if [ -n "$src" ]; then
    if [ "$src" != "$DOCKER_IMG" ]; then die_foreign "в fstab для $DATA_ROOT чужая запись ($src)"; fi
    if ! awk -v mp="$DATA_ROOT" '$2 == mp && $4 ~ /(^|,)(pquota|prjquota)(,|$)/ {f = 1} END {exit !f}' "$fstab"; then
      warn "в fstab у $DATA_ROOT нет pquota: исправь строку вручную (loop,noatime,pquota)"
    fi
    log "fstab: запись для $DATA_ROOT уже есть"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then plan "добавить в $fstab: $line (копия fstab.wom-backup-*)"; return 0; fi
  ensure_work
  stamp=$(date +%Y%m%d-%H%M%S)
  if [ -f "$fstab" ]; then cp -p "$fstab" "$fstab.wom-backup-$stamp"; fi
  new=$WORK/fstab.new
  : > "$new"
  if [ -f "$fstab" ]; then
    cat "$fstab" > "$new"
    if [ -s "$fstab" ] && [ -n "$(tail -c1 "$fstab")" ]; then printf '\n' >> "$new"; fi
  fi
  printf '%s\n' "$line" >> "$new"
  install -m 0644 "$new" "$fstab"
  log "fstab: добавил $DATA_ROOT (прежний файл: $fstab.wom-backup-$stamp)"
}

step_volume() {
  step "Том под data-root Docker ($DATA_ROOT)"
  local itype used opts fs
  ensure_dir "$(dirname "$DATA_ROOT")" 755 root:root 0
  if [ "$DATA_ROOT_MODE" = adopt ]; then
    log "режим adopt: $DATA_ROOT используется как есть, образ и fstab не трогаю"
    ensure_dir "$DATA_ROOT" 700 "$USER_NAME:$USER_NAME" 2
    fs=$(mount_fstype "$DATA_ROOT")
    if [ -n "$fs" ] && [ "$fs" != xfs ]; then warn "$DATA_ROOT на файловой системе $fs, а не xfs: квот проектов не будет"; fi
    return 0
  fi
  ensure_dir "$(dirname "$DOCKER_IMG")" 755 root:root 0
  if [ ! -f "$DOCKER_IMG" ]; then
    run truncate -s "${DOCKER_IMG_GB}G" "$DOCKER_IMG"
    run chmod 600 "$DOCKER_IMG"
  fi
  itype=""; if [ -f "$DOCKER_IMG" ]; then itype=$(image_fs_type "$DOCKER_IMG"); fi
  if [ -z "$itype" ]; then
    # only a blank file is formatted: an unknown signature plus real data means somebody else's file
    used=0; if [ -f "$DOCKER_IMG" ]; then used=$(image_used_kb "$DOCKER_IMG"); fi
    if [ "${used:-0}" -gt 65536 ]; then
      die_foreign "$DOCKER_IMG занимает $((used / 1024)) МБ и не похож на пустой образ: форматировать не буду."
    fi
    run mkfs.xfs -q "$DOCKER_IMG"
  else
    log "образ $DOCKER_IMG уже отформатирован ($itype)"
  fi
  fstab_ensure_entry
  if [ "$DRY_RUN" != 1 ]; then systemctl daemon-reload; else plan "systemctl daemon-reload"; fi
  if ! is_mountpoint "$DATA_ROOT"; then
    run mkdir -p "$DATA_ROOT"
    run mount "$DATA_ROOT"
    if [ "$DRY_RUN" != 1 ] && ! is_mountpoint "$DATA_ROOT"; then die "mount $DATA_ROOT не смонтировал том"; fi
  else
    log "$DATA_ROOT уже смонтирован"
  fi
  ensure_dir "$DATA_ROOT" 700 "$USER_NAME:$USER_NAME" 2
  if [ "$DRY_RUN" != 1 ]; then
    opts=$(mount_options "$DATA_ROOT")
    case ",$opts," in
      *,pquota,*|*,prjquota,*) ;;
      *) warn "$DATA_ROOT смонтирован без pquota ($opts): перемонтируй (umount $DATA_ROOT && mount $DATA_ROOT) в тихое окно" ;;
    esac
  fi
}

step_dirs() {
  step "Каталоги: бэкапы и данные PostgreSQL"
  ensure_dir "$BACKUPS_DIR" 700 "$USER_NAME:$USER_NAME"
  if [ -d "$PGDATA_DIR" ]; then
    # after the first start the content belongs to a subuid (uid 70 of the container): do not reclaim or chmod it
    log "$PGDATA_DIR уже есть: не трогаю (внутри владелец subuid, это нормально)"
    if [ "$(stat -c %u "$PGDATA_DIR")" = 0 ]; then run chown "$USER_NAME:$USER_NAME" "$PGDATA_DIR"; fi
  else
    ensure_dir "$PGDATA_DIR" 700 "$USER_NAME:$USER_NAME"
  fi
}

ssh_ports() {
  local p
  { command -v sshd >/dev/null 2>&1 && sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'; } || true
  p=${SSH_CONNECTION:-}; p=${p##* }
  case $p in ''|*[!0-9]*) ;; *) printf '%s\n' "$p" ;; esac
}

step_firewall() {
  step "Файрвол ufw (22, 80, 443)"
  local port
  if [ "$FIREWALL" != 1 ]; then log "--no-firewall: ufw не трогаю"; return 0; fi
  run ufw default deny incoming
  run ufw default allow outgoing
  # allow ssh first: enabling the firewall must never cut the session this script runs in
  for port in $( { echo 22; ssh_ports; } | sort -un ); do run ufw allow "$port/tcp"; done
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  run ufw --force enable
}

step_ssh() {
  step "Ужесточение sshd"
  local conf="$FS_ROOT/etc/ssh/sshd_config.d/00-wom-hardening.conf" main="$FS_ROOT/etc/ssh/sshd_config" eff
  if [ "$HARDEN_SSH" != 1 ]; then log "--no-harden-ssh: sshd не трогаю"; SSH_STATE="не менялся (--no-harden-ssh)"; return 0; fi
  if ! has_valid_key_line "$FS_ROOT/root/.ssh/authorized_keys"; then
    warn "sshd не ужесточён: у root нет ssh-ключа, отключение паролей закрыло бы доступ. Сделай ssh-copy-id под root и запусти скрипт снова."
    SSH_STATE="не ужесточён: у root нет ключа"; return 0
  fi
  if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' "$main" 2>/dev/null; then
    warn "в $main нет Include sshd_config.d: drop-in не подействовал бы, sshd не менял"
    SSH_STATE="не ужесточён: нет Include в sshd_config"; return 0
  fi
  # 00- sorts first, and sshd keeps the FIRST value it reads, so cloud-init's 50-cloud-init.conf cannot re-enable passwords
  put_file "$conf" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: keys only. Written only because root has an authorized key.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if [ "$DRY_RUN" = 1 ]; then plan "sshd -t && systemctl reload ssh"; SSH_STATE="будет ужесточён"; return 0; fi
  if ! sshd -t 2>/dev/null; then
    rm -f "$conf"
    warn "sshd -t отклонил конфигурацию, drop-in $conf удалён, sshd не менялся"
    SSH_STATE="не ужесточён: sshd -t отклонил"; return 0
  fi
  eff=$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2; exit}' || true)
  if [ "$PUT_CHANGED" = 1 ]; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd || warn "не удалось перечитать конфигурацию sshd"
  fi
  if [ "$eff" = no ] || [ -z "$eff" ]; then SSH_STATE="ужесточён (вход только по ключам)"
  else
    warn "sshd -T показывает passwordauthentication=$eff: другой файл или Match-блок перекрывает $conf"
    SSH_STATE="drop-in записан, но пароль всё ещё разрешён"
  fi
}

step_unattended() {
  step "unattended-upgrades"
  put_file "$FS_ROOT/etc/apt/apt.conf.d/20auto-upgrades" 644 root:root <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  if [ "$DRY_RUN" = 1 ]; then plan "systemctl enable --now apt-daily.timer apt-daily-upgrade.timer"; return 0; fi
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || warn "таймеры apt-daily не включились"
}

cgroup_controllers_file() { printf '/sys/fs/cgroup/user.slice/user-%s.slice/user@%s.service/cgroup.controllers' "$1" "$1"; }
delegation_ok() { # UID
  local f c; f=$(cgroup_controllers_file "$1")
  [ -r "$f" ] || return 1
  for c in cpu memory pids; do
    case " $(cat "$f") " in *" $c "*) ;; *) return 1 ;; esac
  done
}

step_cgroup() {
  step "Делегирование cgroup v2 пользователю $USER_NAME (cpu memory pids)"
  local uid
  put_file "$FS_ROOT/etc/systemd/system/user@.service.d/delegate.conf" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: without delegation rootless Docker silently ignores mem_limit/pids_limit
[Service]
Delegate=cpu cpuset io memory pids
EOF
  if [ "$PUT_CHANGED" = 1 ]; then run systemctl daemon-reload; fi
  if [ "$DRY_RUN" = 1 ]; then plan "если контроллеров нет: systemctl restart user@<uid>.service (только пока rootless Docker не запущен)"; return 0; fi
  uid=$(user_uid)
  if delegation_ok "$uid"; then log "делегировано: cpu memory pids"; return 0; fi
  if as_user systemctl --user is-active --quiet docker.service 2>/dev/null; then
    warn "cgroup не делегированы, а rootless Docker уже работает: перезапуск менеджера пользователя убил бы песочницы. Перезагрузи хост в тихое окно."
    return 0
  fi
  log "перезапускаю user@$uid.service, чтобы подействовало делегирование"
  systemctl restart "user@$uid.service"
  wait_for "шина пользователя" 60 test -S "/run/user/$uid/bus" || die "менеджер пользователя не поднялся после перезапуска"
  delegation_ok "$uid" || true
}

keyring_and_repo_docker() {
  local codename arch distro fallback
  distro=$(os_field ID)
  case "$distro" in
    ubuntu) codename=$(os_field VERSION_CODENAME); codename=${codename:-noble}; fallback=noble ;;
    *) distro=debian; codename=$(os_field VERSION_CODENAME); codename=${codename:-trixie}; fallback=bookworm ;;
  esac
  arch=$(dpkg --print-architecture)
  install_keyring "https://download.docker.com/linux/$distro/gpg" /etc/apt/keyrings/docker.gpg "$DOCKER_GPG_FPR"
  # runbook 3: use the older codename only when Docker has no repository for this one yet
  if ! curl -fsI --max-time 20 "https://download.docker.com/linux/$distro/dists/$codename/Release" >/dev/null 2>&1; then
    warn "у Docker нет репозитория для $codename, использую $fallback (пакеты совместимы)"
    codename=$fallback
  fi
  put_file "$FS_ROOT/etc/apt/sources.list.d/docker.list" 644 root:root <<EOF
deb [arch=$arch signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$distro $codename stable
EOF
}

# Ubuntu 24.04 forbids unprivileged user namespaces to programs without an AppArmor profile: rootlesskit gets one (the
# alternative, kernel.apparmor_restrict_unprivileged_userns=0, would loosen the whole machine). Debian has no such switch.
step_apparmor_rootlesskit() {
  local prof="$FS_ROOT/etc/apparmor.d/usr.bin.rootlesskit"
  if [ "$(os_field ID)" != ubuntu ]; then return 0; fi
  step "AppArmor: профиль rootlesskit (Ubuntu)"
  if [ "$DRY_RUN" = 1 ]; then plan "записать /etc/apparmor.d/usr.bin.rootlesskit (userns для /usr/bin/rootlesskit) и apparmor_parser -r"; return 0; fi
  if [ ! -d "$FS_ROOT/etc/apparmor.d" ]; then log "AppArmor не установлен: профиль не нужен"; return 0; fi
  put_file "$prof" 644 root:root <<'EOF'
# Managed by wom host-setup.sh: lets rootless Docker create user namespaces on Ubuntu 24.04
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,

  include if exists <local/usr.bin.rootlesskit>
}
EOF
  if [ "$PUT_CHANGED" = 1 ] && command -v apparmor_parser >/dev/null 2>&1 && [ -z "$FS_ROOT" ]; then
    apparmor_parser -r "$prof" || warn "apparmor_parser не загрузил профиль rootlesskit: rootless Docker может не стартовать (journalctl -k | grep apparmor)"
  fi
}

step_docker_install() {
  step "Docker Engine (пакеты, системный демон отключён)"
  local -a missing=(); local p
  for p in "${DOCKER_PACKAGES[@]}"; do
    if ! pkg_installed "$p"; then missing+=("$p"); fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      plan "добавить репозиторий Docker (проверка отпечатка $DOCKER_GPG_FPR; при отсутствии trixie — bookworm)"
      plan "apt-get install ${missing[*]}"
    else
      keyring_and_repo_docker
      DEBIAN_FRONTEND=noninteractive apt-get update -q
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing[@]}"
    fi
  else
    log "пакеты Docker уже установлены"
  fi
  # all containers live in the user's rootless daemon; the root daemon is unnecessary attack surface
  if [ "$DRY_RUN" = 1 ]; then plan "systemctl disable --now docker.service docker.socket"; return 0; fi
  systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true
}

# render_daemon_json EXISTING_FILE: daemon.json with our keys merged over whatever was there
render_daemon_json() {
  local base='{}'
  if [ -s "$1" ]; then base=$(cat "$1"); fi
  printf '%s' "$base" | jq -S --arg dr "$DATA_ROOT" '
    . + {"data-root": $dr, "log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"},
         "default-address-pools": [{"base": "10.200.0.0/12", "size": 24}]}'
}

ensure_bashrc_block() {
  local rc begin='# >>> wom host-setup >>>' end='# <<< wom host-setup <<<' new
  rc="$(user_home)/.bashrc"
  if [ -f "$rc" ] && grep -qF -- "$begin" "$rc"; then log "~/.bashrc: блок wom уже есть"; return 0; fi
  # at the very top: Debian's .bashrc returns early for non-interactive shells, and `ssh wom@host docker ps` is one
  new=$(printf '%s\n%s\n%s\n%s\n%s\n' "$begin" \
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"' \
    'export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"' \
    'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac' "$end")
  if [ -f "$rc" ]; then new=$(printf '%s\n%s' "$new" "$(cat "$rc")"); fi
  put_file "$rc" 644 "$USER_NAME:$USER_NAME" <<< "$new"
}

step_docker_rootless() {
  step "Rootless Docker пользователя $USER_NAME"
  local home uid unit conf_changed=0 sock was_running=0
  home=$(user_home)
  user_mkdir .config/docker; user_mkdir .config/systemd/user/docker.service.d
  if [ "$DRY_RUN" = 1 ]; then
    plan "записать $home/.config/docker/daemon.json (data-root $DATA_ROOT, log-opts 10m x3, default-address-pools 10.200.0.0/12 /24)"
    plan "записать $home/.config/systemd/user/docker.service.d/port-driver.conf (DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns)"
    plan "как $USER_NAME: dockerd-rootless-setuptool.sh install; systemctl --user enable --now docker.service"
    plan "дождаться сокета /run/user/<uid>/docker.sock и сверить docker info (rootless, data-root, cgroup v2)"
    return 0
  fi
  ensure_work
  render_daemon_json "$home/.config/docker/daemon.json" > "$WORK/daemon.json" 2>/dev/null || die "$home/.config/docker/daemon.json не разобрался как JSON: поправь или удали файл"
  put_file "$home/.config/docker/daemon.json" 644 "$USER_NAME:$USER_NAME" < "$WORK/daemon.json"
  if [ "$PUT_CHANGED" = 1 ]; then conf_changed=1; fi
  put_file "$home/.config/systemd/user/docker.service.d/port-driver.conf" 644 "$USER_NAME:$USER_NAME" <<'EOF'
# Managed by wom host-setup.sh: the default port driver hides the client address (all rate limits per IP would become shared)
[Service]
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns
EOF
  if [ "$PUT_CHANGED" = 1 ]; then conf_changed=1; fi
  if [ "$DATA_ROOT_MODE" = loop ] || is_mountpoint "$DATA_ROOT"; then
    # fail loudly instead of filling the root disk when the volume is not mounted at boot
    put_file "$home/.config/systemd/user/docker.service.d/data-root.conf" 644 "$USER_NAME:$USER_NAME" <<EOF
# Managed by wom host-setup.sh: never start the daemon on an unmounted data-root
[Unit]
AssertPathIsMountPoint=$DATA_ROOT
EOF
    if [ "$PUT_CHANGED" = 1 ]; then conf_changed=1; fi
  fi
  ensure_bashrc_block

  uid=$(user_uid); unit="$home/.config/systemd/user/docker.service"
  # the daemon that exists before this run read the old configuration; the one that setuptool starts below reads the new one
  was_running=0
  if [ -f "$unit" ] && as_user systemctl --user is-active --quiet docker.service 2>/dev/null; then was_running=1; fi
  if [ ! -f "$unit" ]; then
    log "dockerd-rootless-setuptool.sh install (от $USER_NAME)"
    as_user dockerd-rootless-setuptool.sh install || die "dockerd-rootless-setuptool.sh не отработал (вывод выше)"
  else
    log "юнит docker.service пользователя уже есть"
  fi
  as_user systemctl --user daemon-reload
  if [ "$conf_changed" = 1 ] && [ "$was_running" = 1 ]; then
    warn "настройки Docker изменились, а демон уже работает: применятся после 'systemctl --user restart docker' от $USER_NAME (это завершит все сессии, делай в тихое окно)"
  fi
  as_user systemctl --user enable --now docker.service
  sock="/run/user/$uid/docker.sock"
  wait_for "сокет Docker" 120 test -S "$sock" || die "сокет $sock не появился за 120 с: journalctl --user -u docker (от $USER_NAME)"
  wait_for "ответ демона" 120 as_user_docker docker info || die "демон Docker не отвечает на docker info"
}

verify_docker() {
  local info
  info=$(as_user_docker docker info --format '{{.DockerRootDir}}|{{.CgroupDriver}}|{{.CgroupVersion}}|{{.SecurityOptions}}' 2>/dev/null || true)
  DOCKER_INFO=$info
  case $info in *rootless*) ;; *) FAILURES+=("демон Docker не rootless (SecurityOptions: ${info##*|})") ;; esac
  case $info in "$DATA_ROOT|"*) ;; *) FAILURES+=("data-root демона не $DATA_ROOT: ${info%%|*}") ;; esac
  case $info in *"|2|"*) ;; *) FAILURES+=("Docker не на cgroup v2") ;; esac
}

detect_kind_version() {
  local v=${WOM_KIND_VERSION:-} df="$REPO_ROOT/services/orchestrator/Dockerfile"
  if [ -z "$v" ] && [ -r "$df" ]; then
    v=$(sed -n 's/^ARG KIND_VERSION=\(v[0-9][0-9.]*\)[[:space:]]*$/\1/p' "$df" | head -n1)
  fi
  printf '%s' "${v:-$KIND_VERSION_FALLBACK}"
}

fetch_first_field() { # URL: first whitespace-separated field of the first line (a *.sha256sum file)
  curl -fsSL --retry 3 --connect-timeout 15 "$1" | awk '{print $1; exit}'
}

step_kind() {
  step "kind"
  local ver bin home base expected actual cur
  ver=$(detect_kind_version); home=$(user_home); bin="$home/.local/bin/kind"
  [[ $ver =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "версия kind '$ver' не похожа на vX.Y.Z"
  KIND_VERSION=$ver
  user_mkdir .local/bin
  if [ -x "$bin" ]; then
    # run as the service user: root must never execute a file that the (less trusted) service user can replace
    cur=$(as_user "$bin" version 2>/dev/null || true)
    case $cur in *" $ver "*) log "kind $ver уже установлен"; return 0 ;; esac
  fi
  base="https://kind.sigs.k8s.io/dl/$ver/kind-linux-amd64"
  if [ "$DRY_RUN" = 1 ]; then plan "скачать $base, сверить sha256 с $base.sha256sum, установить в $bin (0755, $USER_NAME)"; return 0; fi
  ensure_work
  curl -fsSL --retry 3 --connect-timeout 15 -o "$WORK/kind" "$base" || die "не скачался $base"
  # WOM_KIND_SHA256 pins the hash from outside; otherwise the checksum published next to the binary is used
  expected=${WOM_KIND_SHA256:-}
  if [ -z "$expected" ]; then
    expected=$(fetch_first_field "$base.sha256sum" || fetch_first_field "https://github.com/kubernetes-sigs/kind/releases/download/$ver/kind-linux-amd64.sha256sum") ||
      die "не скачалась контрольная сумма kind $ver (ни с kind.sigs.k8s.io, ни с GitHub); можно задать её явно через WOM_KIND_SHA256"
  fi
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "контрольная сумма kind имеет неверный формат"
  actual=$(sha256sum "$WORK/kind" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then die "sha256 kind не совпал (ожидалось $expected, получено $actual): не устанавливаю"; fi
  install -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$WORK/kind" "$bin"
  log "kind $ver установлен: $bin (sha256 совпал)"
}

step_verify() {
  step "Проверка"
  local uid; uid=$(user_uid)
  if [ "$DRY_RUN" = 1 ]; then plan "проверить делегирование cgroup, docker info, ufw, kind"; return 0; fi
  if delegation_ok "$uid"; then log "cgroup: cpu memory pids делегированы"
  else FAILURES+=("cgroup: пользователю не делегированы cpu/memory/pids, лимиты контейнеров не будут работать (проверь $(cgroup_controllers_file "$uid"), при необходимости перезагрузи хост)"); fi
  verify_docker
  case " $(user_groups) " in *" sudo "*) FAILURES+=("$USER_NAME остался в группе sudo") ;; esac
  if [ "$FIREWALL" = 1 ] && ! ufw status 2>/dev/null | grep '^Status: active' >/dev/null; then FAILURES+=("ufw не активен"); fi
  if [ "${#FAILURES[@]}" -eq 0 ]; then log "проверки пройдены"; fi
}

write_report() {
  local f="$FS_ROOT/root/wom-host-setup.report" dv kv
  if [ "$DRY_RUN" = 1 ]; then plan "записать отчёт $f"; return 0; fi
  dv=$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || echo n/a)
  kv=$(detect_kind_version)
  {
    echo "Game of Incidents: отчёт host-setup.sh (без секретов)"
    echo "Дата: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Хост: $(hostname) / $(os_field PRETTY_NAME) / ядро $(uname -r)"
    echo "Ресурсы: $(get_nproc) CPU, $(( $(get_mem_kb) / 1024 / 1024 )) ГБ RAM"
    echo "Пользователь: $USER_NAME (uid $(user_uid)), без sudo; группы: $(user_groups)"
    echo "Docker CE: $dv; rootless; сведения демона: ${DOCKER_INFO:-n/a}"
    echo "kind: ${KIND_VERSION:-$kv}; node: $(command -v node >/dev/null 2>&1 && node -v || echo нет)"
    echo "data-root: $DATA_ROOT, режим $DATA_ROOT_MODE, образ $DOCKER_IMG ($DOCKER_IMG_GB ГБ), опции монтирования: $(mount_options "$DATA_ROOT")"
    echo "Каталоги: бэкапы $BACKUPS_DIR (700), PostgreSQL $PGDATA_DIR"
    echo "Файрвол: $(if [ "$FIREWALL" = 1 ]; then ufw status 2>/dev/null | head -n1; else echo 'не трогали (--no-firewall)'; fi)"
    echo "sshd: $SSH_STATE"
    echo "Делегирование cgroup: $(if delegation_ok "$(user_uid)"; then echo 'cpu memory pids'; else echo 'НЕТ'; fi)"
    if [ "${#WARNINGS[@]}" -gt 0 ]; then echo "Предупреждения:"; printf '  - %s\n' "${WARNINGS[@]}"; fi
    if [ "${#FAILURES[@]}" -gt 0 ]; then echo "Не прошли проверки:"; printf '  - %s\n' "${FAILURES[@]}"; fi
  } > "$f.tmp"
  install -m 0600 "$f.tmp" "$f"; rm -f "$f.tmp"
  log "отчёт: $f"
}

main() {
  trap cleanup EXIT
  ensure_work
  parse_args "$@"
  check_env
  check_system_docker
  decide_data_root_mode
  check_disk
  if [ "$DRY_RUN" = 1 ]; then
    log "режим --dry-run: ничего не меняю, печатаю план"
  elif command -v flock >/dev/null 2>&1 && [ -d "$FS_ROOT/run/lock" ]; then
    # two parallel runs would fight over apt, fstab and the user manager
    exec 9> "$FS_ROOT/run/lock/wom-host-setup.lock"
    flock -n 9 || die "host-setup.sh уже запущен в другом сеансе (замок $FS_ROOT/run/lock/wom-host-setup.lock)"
  fi

  step_packages
  step_node
  step_user
  step_authorized_keys
  step_subids
  step_linger
  step_modules_sysctl
  step_volume
  step_dirs
  step_cgroup
  step_firewall
  step_ssh
  step_unattended
  step_docker_install
  step_apparmor_rootlesskit
  step_docker_rootless
  step_kind
  step_verify
  write_report

  if [ "${#FAILURES[@]}" -gt 0 ]; then
    printf 'host-setup: НЕ ГОТОВО:\n' >&2; printf '  - %s\n' "${FAILURES[@]}" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = 1 ]; then log "план напечатан, на хосте ничего не изменилось"; exit 0; fi
  log "хост готов. Дальше от пользователя $USER_NAME: scripts/provision/app-setup.sh --domain <домен> (его запускает provision.sh)"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
