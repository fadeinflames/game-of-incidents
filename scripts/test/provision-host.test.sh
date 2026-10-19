#!/usr/bin/env bash
# scripts/provision/host-setup.sh (zone A): argument parsing, environment checks and exit codes, --dry-run without side
# effects, and the idempotent file-writing steps against a throwaway root (the WOM_FS_ROOT prefix).
# The script is sourced in a child bash with every system command (useradd, mount, ufw, apt-get, systemctl, ...) replaced by a
# recorder, so nothing here needs root, Linux or the network; checks that need jq or real file modes skip themselves.
set -u
cd "$(dirname "$0")"
. ./helpers.sh

HS="$(cd ../provision && pwd)/host-setup.sh"
[ -f "$HS" ] || { fail "host-setup.sh exists"; finish; }

if bash -n "$HS" 2>/dev/null; then pass "bash -n host-setup.sh"; else fail "bash -n host-setup.sh"; fi

cat > "$TMP/shadows.sh" <<'EOF'
# every command that changes the machine is a recorder; probes stay real unless a test overrides them
rec() { printf '%s\n' "$*" >> "$CALLS"; }
for c in useradd usermod gpasswd loginctl runuser modprobe sysctl mkfs.xfs mount ufw apt-get chown; do
  eval "$c() { rec $c \"\$@\"; }"
done
systemctl() { case ${1:-} in is-active) return 1 ;; esac; rec systemctl "$@"; }
sshd() { return 0; }
docker() { :; }
curl() { rec curl "$@"; }
# install -o/-g need root: drop them and install for real
# (and `install -d -m` fails on NTFS under Git Bash, so directories are made with mkdir + chmod)
install() {
  local a=() dir=0 mode="" last=""
  while [ $# -gt 0 ]; do
    case $1 in -o|-g) shift 2 ;; -d) dir=1; shift ;; -m) mode=$2; shift 2 ;; *) a+=("$1"); last=$1; shift ;; esac
  done
  if [ "$dir" = 1 ]; then mkdir -p "$last"; if [ -n "$mode" ]; then chmod "$mode" "$last" 2>/dev/null || true; fi; return 0; fi
  command install ${mode:+-m "$mode"} "${a[@]}"
}
# machine that passes check_env (os-release comes from FS_ROOT)
GOOD='get_uid(){ echo 0; }; get_nproc(){ echo 8; }; get_mem_kb(){ echo 33000000; }; get_arch(){ echo x86_64; }; cgroup_fstype(){ echo cgroup2fs; }; systemd_present(){ true; }'
fake_curl() { # serves "binary-bytes" for -o downloads and $FAKE_SHA for *.sha256sum
  local out="" url="" prev="" a
  for a in "$@"; do
    if [ "$prev" = -o ]; then out=$a; fi
    prev=$a; url=$a
  done
  case $url in
    *.sha256sum) printf '%s  kind-linux-amd64\n' "$FAKE_SHA" ;;
    *) printf 'binary-bytes' > "$out" ;;
  esac
}
EOF
# run_hs CODE: the code runs in a child bash after the script and the shadows were sourced
run_hs() { CALLS="$TMP/calls" bash -c 'source "$1"; source "$2"; trap cleanup EXIT; shift 2; eval "$1"' _ "$HS" "$TMP/shadows.sh" "$1"; }
calls() { cat "$TMP/calls" 2>/dev/null || true; }
reset_calls() { : > "$TMP/calls"; }

mkos() { # DIR ID VERSION_ID CODENAME: a fake /etc/os-release under DIR
  mkdir -p "$1/etc"
  printf 'PRETTY_NAME="%s %s"\nID=%s\nVERSION_ID="%s"\nVERSION_CODENAME=%s\n' "$2" "$3" "$2" "$3" "$4" > "$1/etc/os-release"
}
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLE0123456789ab admin@laptop'
KEY2='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHEROTHEROTHEROTHEROTHER0123456789cd second@laptop'

echo "arguments"
out=$(run_hs 'parse_args; echo "$USER_NAME $DATA_ROOT $DOCKER_IMG $DOCKER_IMG_GB $BACKUPS_DIR $PGDATA_DIR $FIREWALL $HARDEN_SSH $ADOPT $DRY_RUN"' 2>&1); rc=$?
assert_eq "defaults: exit" 0 $rc
assert_eq "defaults (the image size is chosen later from the free space)" "wom /srv/docker /srv/images/docker.img  /srv/backups /srv/pgdata 1 1 0 0" "$out"
out=$(run_hs 'parse_args --user bob --data-root=/d/x/ --docker-img /d/i/x.img --docker-img-gb 40 --backups-dir /b --pgdata-dir=/p --no-firewall --no-harden-ssh --adopt --dry-run; echo "$USER_NAME $DATA_ROOT $DOCKER_IMG $DOCKER_IMG_GB $BACKUPS_DIR $PGDATA_DIR $FIREWALL $HARDEN_SSH $ADOPT $DRY_RUN"' 2>&1); rc=$?
assert_eq "all options: exit" 0 $rc
assert_eq "all options (forms --k v and --k=v, trailing slash dropped)" "bob /d/x /d/i/x.img 40 /b /p 0 0 1 1" "$out"
out=$(run_hs 'parse_args --help' 2>&1); rc=$?
assert_eq "--help exits 0" 0 $rc
assert_contains "--help describes the options" "$out" "--adopt"
for bad in "--nope" "--user" "--user Root" "--user root" "--docker-img-gb 10" "--docker-img-gb abc" "--data-root relative/dir" "--data-root /srv/a..b/../c" \
  "--data-root /srv/d --docker-img /srv/d/x.img" "--data-root /srv/d --pgdata-dir /srv/d/pg" "--backups-dir /x --pgdata-dir /x"; do
  out=$(run_hs "parse_args $bad" 2>&1); rc=$?
  assert_eq "usage error exits 64: $bad" 64 $rc
done
assert_contains "a usage error is in Russian" "$out" "должны различаться"

echo "environment checks and exit codes"
# a real (non-root) run of the script: it must refuse with exit 2 before touching anything
if [ "$(id -u)" != 0 ]; then
  out=$(bash "$HS" --dry-run 2>&1); rc=$?
  assert_eq "not root: exit 2" 2 $rc
  assert_contains "not root: says root" "$out" "от root"
else
  skip "running as root: the real not-root refusal is not exercised"
fi
mkos "$TMP/os13" debian 13 trixie; mkos "$TMP/os12" debian 12 bookworm; mkos "$TMP/osu" ubuntu 24.04 noble
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; check_env; echo passed" 2>&1); rc=$?
assert_eq "Debian 13 on a big enough machine passes" 0 $rc
assert_contains "check_env reaches the end" "$out" "passed"
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/osu; check_env; echo passed" 2>&1); rc=$?
assert_eq "Ubuntu 24.04 passes" 0 $rc
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os12; check_env" 2>&1); rc=$?
assert_eq "os12: exit 2" 2 $rc
assert_contains "os12: asks for Debian 13 or Ubuntu 24.04" "$out" "Ubuntu 24.04"
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; get_uid(){ echo 1000; }; check_env" 2>&1); rc=$?
assert_eq "uid 1000: exit 2" 2 $rc
assert_contains "uid 1000: says root" "$out" "от root"
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; get_nproc(){ echo 1; }; get_mem_kb(){ echo 4000000; }; check_env" 2>&1); rc=$?
assert_eq "1 CPU / 4 GB: exit 2" 2 $rc
assert_contains "small machine: names the CPU minimum" "$out" "мало CPU: 1, минимум 2"
out2=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; get_nproc(){ echo 2; }; get_mem_kb(){ echo 8000000; }; check_env; echo passed" 2>&1); rc2=$?
assert_eq "2 CPU / 8 GB is enough to install" 0 $rc2
assert_contains "small machine: names the memory minimum" "$out" "мало памяти"
assert_contains "small machine: recommends 8 CPU / 32 GB" "$out" "рекомендуется 8 CPU и 32 ГБ"
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; get_arch(){ echo aarch64; }; check_env" 2>&1); rc=$?
assert_eq "arm64: exit 2" 2 $rc
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; cgroup_fstype(){ echo tmpfs; }; check_env" 2>&1); rc=$?
assert_eq "cgroup v1: exit 2" 2 $rc
out=$(run_hs "eval \"\$GOOD\"; FS_ROOT=$TMP/os13; get_nproc(){ echo 4; }; get_mem_kb(){ echo 7600000; }; check_env; echo passed" 2>&1); rc=$?
assert_eq "exactly the minimum (4 CPU, ~8 GB) passes" 0 $rc
assert_contains "below the recommendation: a warning" "$out" "меньше рекомендованных"
out=$(run_hs 'DOCKER_IMG=/x/docker.img; DATA_ROOT_MODE=loop; get_free_kb(){ echo 1000000; }; check_disk' 2>&1); rc=$?
assert_eq "less than 40 GB free: exit 2" 2 $rc
out=$(run_hs 'DOCKER_IMG=/x/docker.img; DATA_ROOT_MODE=loop; get_free_kb(){ echo 58000000; }; check_disk; echo "size=$DOCKER_IMG_GB"' 2>&1); rc=$?
assert_eq "55 GB free passes" 0 $rc
assert_contains "the image is sized from the free space, leaving 12 GB" "$out" "size=43"
out=$(run_hs 'DOCKER_IMG=/x/docker.img; DATA_ROOT_MODE=loop; get_free_kb(){ echo 500000000; }; check_disk; echo "size=$DOCKER_IMG_GB"' 2>&1); rc=$?
assert_contains "a large disk gets at most 150 GB" "$out" "size=150"
out=$(run_hs 'DOCKER_IMG=/x/docker.img; DATA_ROOT_MODE=loop; DOCKER_IMG_GB=150; get_free_kb(){ echo 70000000; }; check_disk; echo passed' 2>&1); rc=$?
assert_eq "an explicit size larger than the free space passes" 0 $rc
assert_contains "image larger than free space: a warning about the sparse file" "$out" "разреженный"

echo "data-root: foreign data (exit 3), adopt, our own volume"
mkdir -p "$TMP/dr1/foreign" "$TMP/dr2" "$TMP/dr"
echo data > "$TMP/dr1/foreign/file"
base="DOCKER_IMG=$TMP/dr/docker.img; FS_ROOT=$TMP/fs3; mkdir -p \$FS_ROOT/etc; is_mountpoint(){ return 1; }"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr1; decide_data_root_mode" 2>&1); rc=$?
assert_eq "non-empty data-root without --adopt: exit 3" 3 $rc
assert_contains "foreign data: explains --adopt" "$out" "--adopt"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr1; ADOPT=1; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1); rc=$?
assert_eq "non-empty data-root with --adopt: exit 0" 0 $rc
assert_contains "adopt mode" "$out" "mode=adopt"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1)
assert_contains "empty data-root: a new loop volume" "$out" "mode=loop"
mkdir -p "$TMP/dr4/lost+found"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr4; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1)
assert_contains "lost+found alone does not count as data" "$out" "mode=loop"
# our own fstab entry: a re-run on a provisioned host, even though the directory holds Docker data
printf '%s %s xfs loop,noatime,pquota 0 0\n' "$TMP/dr/docker.img" "$TMP/dr1" > "$TMP/fs3/etc/fstab"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr1; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1); rc=$?
assert_eq "own fstab entry with data inside: exit 0" 0 $rc
assert_contains "own fstab entry: loop mode (idempotent re-run)" "$out" "mode=loop"
printf '/dev/vg0/docker %s xfs defaults 0 0\n' "$TMP/dr2" > "$TMP/fs3/etc/fstab"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; decide_data_root_mode" 2>&1); rc=$?
assert_eq "foreign fstab entry without --adopt: exit 3" 3 $rc
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; ADOPT=1; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1)
assert_contains "foreign fstab entry with --adopt: adopt mode" "$out" "mode=adopt"
: > "$TMP/fs3/etc/fstab"
echo x > "$TMP/dr2/f"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; is_mountpoint(){ return 0; }; mount_source(){ echo /dev/vg0/docker; }; decide_data_root_mode" 2>&1); rc=$?
assert_eq "foreign mounted volume with data: exit 3" 3 $rc
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; is_mountpoint(){ return 0; }; mount_source(){ echo /dev/loop3; }; is_loop_of_img(){ [ \"\$1\" = /dev/loop3 ]; }; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1); rc=$?
assert_eq "our loop device mounted by hand, with data: exit 0" 0 $rc
assert_contains "our loop device: loop mode" "$out" "mode=loop"
rm -f "$TMP/dr2/f"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; is_mountpoint(){ return 0; }; mount_source(){ echo /dev/vg0/docker; }; decide_data_root_mode; echo mode=\$DATA_ROOT_MODE" 2>&1)
assert_contains "empty foreign volume (the LVM layout of the runbook): used as it is" "$out" "mode=adopt"
printf 'x' > "$TMP/dr/docker.img"
out=$(run_hs "$base; DATA_ROOT=$TMP/dr2; image_fs_type(){ echo ext4; }; decide_data_root_mode" 2>&1); rc=$?
assert_eq "an existing image with ext4 is never formatted: exit 3" 3 $rc
out=$(run_hs 'docker() { echo x; }; systemctl() { return 0; }; check_system_docker' 2>&1); rc=$?
assert_eq "a running system Docker with containers: exit 3" 3 $rc

echo "fstab entry"
mkdir -p "$TMP/fs4/etc"
printf '/dev/sda1 / ext4 defaults 0 1' > "$TMP/fs4/etc/fstab"   # no trailing newline on purpose
fsetup="FS_ROOT=$TMP/fs4; DOCKER_IMG=/srv/images/docker.img; DATA_ROOT=/srv/docker"
out=$(run_hs "$fsetup; fstab_ensure_entry" 2>&1); rc=$?
assert_eq "fstab_ensure_entry exit" 0 $rc
assert_eq "fstab: two lines, the entry on its own line" 2 "$(wc -l < "$TMP/fs4/etc/fstab" | tr -d ' ')"
assert_contains "fstab: loop, noatime, pquota" "$(cat "$TMP/fs4/etc/fstab")" "/srv/images/docker.img /srv/docker xfs loop,noatime,pquota,nofail 0 0"
assert_contains "fstab: the old content is intact" "$(cat "$TMP/fs4/etc/fstab")" "/dev/sda1 / ext4 defaults 0 1"
assert_eq "fstab: a backup copy was made" 1 "$(ls "$TMP"/fs4/etc/fstab.wom-backup-* 2>/dev/null | wc -l | tr -d ' ')"
sum1=$(cksum < "$TMP/fs4/etc/fstab")
out=$(run_hs "$fsetup; fstab_ensure_entry" 2>&1)
assert_eq "fstab: a second run changes nothing" "$sum1" "$(cksum < "$TMP/fs4/etc/fstab")"
assert_eq "fstab: and makes no second backup" 1 "$(ls "$TMP"/fs4/etc/fstab.wom-backup-* | wc -l | tr -d ' ')"
mkdir -p "$TMP/fs5/etc"; printf '/dev/other /srv/docker ext4 defaults 0 2\n' > "$TMP/fs5/etc/fstab"
out=$(run_hs "FS_ROOT=$TMP/fs5; DOCKER_IMG=/srv/images/docker.img; DATA_ROOT=/srv/docker; fstab_ensure_entry" 2>&1); rc=$?
assert_eq "fstab: a foreign line for the data-root is never overwritten (exit 3)" 3 $rc
mkdir -p "$TMP/fs6/etc"; printf '/dev/sda1 / ext4 defaults 0 1\n' > "$TMP/fs6/etc/fstab"
out=$(run_hs "FS_ROOT=$TMP/fs6; DOCKER_IMG=/srv/images/docker.img; DATA_ROOT=/srv/docker; DRY_RUN=1; fstab_ensure_entry" 2>&1)
assert_eq "fstab: --dry-run writes nothing" 1 "$(wc -l < "$TMP/fs6/etc/fstab" | tr -d ' ')"
assert_contains "fstab: --dry-run prints the plan" "$out" "[план]"

echo "ssh keys"
mkdir -p "$TMP/keys"
printf '# comment\n\n%s\n%s\n' "$KEY" "$KEY2" > "$TMP/keys/src"
printf '%s' "$KEY" > "$TMP/keys/dst"      # one key already there, no trailing newline
out=$(run_hs "merge_authorized_keys $TMP/keys/src $TMP/keys/dst; echo added=\$KEYS_ADDED" 2>&1)
assert_contains "merge adds only the missing key" "$out" "added=1"
assert_eq "merge: both keys, no duplicates, comments skipped" 2 "$(wc -l < "$TMP/keys/dst" | tr -d ' ')"
out=$(run_hs "merge_authorized_keys $TMP/keys/src $TMP/keys/dst; echo added=\$KEYS_ADDED" 2>&1)
assert_contains "merge is idempotent" "$out" "added=0"
printf '# only a comment\n' > "$TMP/keys/none"
if run_hs "has_valid_key_line $TMP/keys/none" >/dev/null 2>&1; then fail "a comment-only file is not a key"; else pass "a comment-only file is not a key"; fi
if run_hs "has_valid_key_line $TMP/keys/src" >/dev/null 2>&1; then pass "a real key line is recognised"; else fail "a real key line is recognised"; fi
# the whole step: root has a key -> the user gets it with the right modes
mkdir -p "$TMP/fs7/root/.ssh" "$TMP/home7"
printf '%s\n' "$KEY" > "$TMP/fs7/root/.ssh/authorized_keys"
out=$(run_hs "FS_ROOT=$TMP/fs7; user_home(){ echo $TMP/home7; }; step_authorized_keys" 2>&1); rc=$?
assert_eq "step_authorized_keys exit" 0 $rc
assert_contains "the user got root's key" "$(cat "$TMP/home7/.ssh/authorized_keys")" "admin@laptop"
if modes_work; then
  assert_eq "authorized_keys is 600" 600 "$(stat -c %a "$TMP/home7/.ssh/authorized_keys")"
  assert_eq "~/.ssh is 700" 700 "$(stat -c %a "$TMP/home7/.ssh")"
else skip "this filesystem ignores chmod: key file modes are not checked"; fi
mkdir -p "$TMP/fs8/root/.ssh" "$TMP/home8"
out=$(run_hs "FS_ROOT=$TMP/fs8; user_home(){ echo $TMP/home8; }; step_authorized_keys" 2>&1); rc=$?
assert_eq "root without keys: still exit 0" 0 $rc
assert_contains "root without keys: warns about ssh-copy-id" "$out" "ssh-copy-id"
if [ -e "$TMP/home8/.ssh/authorized_keys" ]; then fail "no key file is invented"; else pass "no key file is invented"; fi

echo "ssh hardening is skipped when root has no key"
mkdir -p "$TMP/fs9/etc/ssh/sshd_config.d" "$TMP/fs9/root/.ssh"
printf 'Include /etc/ssh/sshd_config.d/*.conf\n' > "$TMP/fs9/etc/ssh/sshd_config"
out=$(run_hs "FS_ROOT=$TMP/fs9; step_ssh" 2>&1); rc=$?
assert_eq "no root key: exit 0" 0 $rc
assert_contains "no root key: explains why sshd was not changed" "$out" "нет ssh-ключа"
if [ -e "$TMP/fs9/etc/ssh/sshd_config.d/00-wom-hardening.conf" ]; then fail "no key: drop-in must not exist"; else pass "no key: drop-in does not exist"; fi
printf '%s\n' "$KEY" > "$TMP/fs9/root/.ssh/authorized_keys"
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs9; step_ssh" 2>&1); rc=$?
assert_eq "root key: exit 0" 0 $rc
drop=$(cat "$TMP/fs9/etc/ssh/sshd_config.d/00-wom-hardening.conf" 2>/dev/null)
assert_contains "root key: passwords off" "$drop" "PasswordAuthentication no"
assert_contains "root key: root by key only" "$drop" "PermitRootLogin prohibit-password"
assert_contains "root key: sshd reloaded" "$(calls)" "systemctl reload ssh"
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs9; step_ssh" 2>&1)
assert_not_contains "second run: no reload" "$(calls)" "reload"
out=$(run_hs "FS_ROOT=$TMP/fs9; HARDEN_SSH=0; step_ssh" 2>&1)
assert_contains "--no-harden-ssh is honoured" "$out" "--no-harden-ssh"
mkdir -p "$TMP/fs10/etc/ssh/sshd_config.d" "$TMP/fs10/root/.ssh"
printf 'Include /etc/ssh/sshd_config.d/*.conf\n' > "$TMP/fs10/etc/ssh/sshd_config"; printf '%s\n' "$KEY" > "$TMP/fs10/root/.ssh/authorized_keys"
out=$(run_hs "FS_ROOT=$TMP/fs10; sshd(){ return 1; }; step_ssh" 2>&1); rc=$?
assert_eq "sshd -t rejects the file: the step still exits 0" 0 $rc
if [ -e "$TMP/fs10/etc/ssh/sshd_config.d/00-wom-hardening.conf" ]; then fail "rejected drop-in is rolled back"; else pass "rejected drop-in is rolled back"; fi
mkdir -p "$TMP/fs11/etc/ssh" "$TMP/fs11/root/.ssh"; printf '%s\n' "$KEY" > "$TMP/fs11/root/.ssh/authorized_keys"; echo "Port 22" > "$TMP/fs11/etc/ssh/sshd_config"
out=$(run_hs "FS_ROOT=$TMP/fs11; step_ssh" 2>&1)
assert_contains "no Include in sshd_config: skipped with a warning" "$out" "Include"

echo "sysctl, modules, unattended-upgrades: written once, re-run changes nothing"
mkdir -p "$TMP/fs12"
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs12; step_modules_sysctl; step_unattended" 2>&1); rc=$?
assert_eq "step_modules_sysctl exit" 0 $rc
assert_contains "ip_unprivileged_port_start" "$(cat "$TMP/fs12/etc/sysctl.d/90-wom.conf")" "net.ipv4.ip_unprivileged_port_start=80"
assert_contains "keyring limit" "$(cat "$TMP/fs12/etc/sysctl.d/90-wom-keyring.conf")" "kernel.keys.maxkeys = 20000"
assert_contains "keyring bytes" "$(cat "$TMP/fs12/etc/sysctl.d/90-wom-keyring.conf")" "kernel.keys.maxbytes = 400000"
assert_contains "inotify instances" "$(cat "$TMP/fs12/etc/sysctl.d/91-wom-inotify.conf")" "fs.inotify.max_user_instances = 1024"
assert_contains "inotify watches" "$(cat "$TMP/fs12/etc/sysctl.d/91-wom-inotify.conf")" "fs.inotify.max_user_watches = 1048576"
assert_contains "kind modules" "$(cat "$TMP/fs12/etc/modules-load.d/90-wom.conf")" "iptable_nat"
assert_contains "automatic upgrades enabled" "$(cat "$TMP/fs12/etc/apt/apt.conf.d/20auto-upgrades")" 'Unattended-Upgrade "1"'
assert_contains "sysctl applied" "$(calls)" "sysctl -q -p"
sum=$(cd "$TMP/fs12" && find . -type f | sort | xargs cksum)
out=$(run_hs "FS_ROOT=$TMP/fs12; step_modules_sysctl; step_unattended" 2>&1)
assert_eq "second run: files byte-identical" "$sum" "$(cd "$TMP/fs12" && find . -type f | sort | xargs cksum)"
assert_contains "second run: reports no changes" "$out" "без изменений: $TMP/fs12/etc/sysctl.d/90-wom.conf"
if modes_work; then assert_eq "sysctl file mode 644" 644 "$(stat -c %a "$TMP/fs12/etc/sysctl.d/90-wom.conf")"; else skip "modes not checked"; fi

echo "cgroup delegation"
printf 'cpuset cpu io memory pids\n' > "$TMP/ctl-ok"; printf 'cpu memory\n' > "$TMP/ctl-bad"
if run_hs "cgroup_controllers_file(){ echo $TMP/ctl-ok; }; delegation_ok 1000" >/dev/null 2>&1; then pass "cpu memory pids present: delegated"; else fail "cpu memory pids present: delegated"; fi
if run_hs "cgroup_controllers_file(){ echo $TMP/ctl-bad; }; delegation_ok 1000" >/dev/null 2>&1; then fail "pids missing: not delegated"; else pass "pids missing: not delegated"; fi
if run_hs "cgroup_controllers_file(){ echo $TMP/none; }; delegation_ok 1000" >/dev/null 2>&1; then fail "no file: not delegated"; else pass "no file: not delegated"; fi
mkdir -p "$TMP/fs13"; reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs13; user_uid(){ echo 1000; }; cgroup_controllers_file(){ echo $TMP/ctl-bad; }; as_user(){ return 0; }; step_cgroup; echo done" 2>&1)
assert_contains "running rootless Docker: a warning instead of killing the sandboxes" "$out" "Перезагрузи хост"
assert_not_contains "running rootless Docker: user@ not restarted" "$(calls)" "restart user@1000"
assert_contains "drop-in written" "$(cat "$TMP/fs13/etc/systemd/system/user@.service.d/delegate.conf")" "Delegate=cpu cpuset io memory pids"
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs13; user_uid(){ echo 1000; }; cgroup_controllers_file(){ echo $TMP/ctl-bad; }; as_user(){ return 1; }; wait_for(){ return 0; }; step_cgroup" 2>&1)
assert_contains "no Docker yet: the user manager is restarted" "$(calls)" "systemctl restart user@1000.service"

echo "user without sudo"
mkdir -p "$TMP/fs14/etc/sudoers.d"; touch "$TMP/fs14/etc/sudoers.d/wom"
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs14; user_exists(){ return 0; }; user_uid(){ echo 1000; }; user_groups(){ echo 'wom sudo docker'; }; step_user" 2>&1); rc=$?
assert_eq "step_user exit" 0 $rc
assert_contains "removed from sudo" "$(calls)" "gpasswd -d wom sudo"
assert_contains "removed from docker (root-equivalent)" "$(calls)" "gpasswd -d wom docker"
if [ -e "$TMP/fs14/etc/sudoers.d/wom" ]; then fail "sudoers.d/wom removed"; else pass "sudoers.d/wom removed"; fi
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs14; user_exists(){ return 1; }; user_groups(){ echo; }; step_user" 2>&1)
assert_contains "new user: useradd -m with bash" "$(calls)" "useradd -m -s /bin/bash wom"
assert_not_contains "new user: never added to sudo" "$(calls)" "usermod -aG"
out=$(run_hs "FS_ROOT=$TMP/fs14; user_exists(){ return 0; }; user_uid(){ echo 0; }; step_user" 2>&1); rc=$?
assert_eq "a user with uid 0 is refused" 1 $rc

echo "subuid/subgid"
mkdir -p "$TMP/fs15/etc"; printf 'a:100000:65536\nb:165536:65536\n' > "$TMP/fs15/etc/subuid"; : > "$TMP/fs15/etc/subgid"
out=$(run_hs "next_subid_start $TMP/fs15/etc/subuid" 2>&1); assert_eq "next range after the last one" 231072 "$out"
out=$(run_hs "next_subid_start $TMP/fs15/etc/subgid" 2>&1); assert_eq "first range starts at 100000" 100000 "$out"
reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs15; step_subids" 2>&1)
assert_contains "subuid range added" "$(calls)" "usermod --add-subuids 231072-296607 wom"
assert_contains "subgid range added" "$(calls)" "usermod --add-subgids 100000-165535 wom"
printf 'wom:231072:65536\n' >> "$TMP/fs15/etc/subuid"; printf 'wom:100000:65536\n' >> "$TMP/fs15/etc/subgid"; reset_calls
out=$(run_hs "FS_ROOT=$TMP/fs15; step_subids" 2>&1)
assert_eq "existing ranges: nothing is called" "" "$(calls)"

echo "directories"
mkdir -p "$TMP/srv16"
reset_calls
out=$(run_hs "BACKUPS_DIR=$TMP/srv16/backups; PGDATA_DIR=$TMP/srv16/pgdata; step_dirs" 2>&1); rc=$?
assert_eq "step_dirs exit" 0 $rc
if [ -d "$TMP/srv16/backups" ] && [ -d "$TMP/srv16/pgdata" ]; then pass "backups and pgdata created"; else fail "backups and pgdata created"; fi
if modes_work; then
  assert_eq "backups is 700" 700 "$(stat -c %a "$TMP/srv16/backups")"
  assert_eq "pgdata is 700" 700 "$(stat -c %a "$TMP/srv16/pgdata")"
else skip "this filesystem ignores chmod: directory modes are not checked"; fi
# an existing pgdata (owned by a subuid after the first start) is left alone: no chmod, no chown of it
reset_calls
out=$(run_hs "BACKUPS_DIR=$TMP/srv16/backups; PGDATA_DIR=$TMP/srv16/pgdata; step_dirs" 2>&1)
assert_contains "existing pgdata is not reclaimed" "$out" "не трогаю"
if [ "$(id -u)" != 0 ]; then
  assert_not_contains "existing pgdata: no chmod/chown of it" "$(calls)" "$TMP/srv16/pgdata"
else skip "running as root: pgdata owner is root here, so the chown is expected"; fi

echo "ensure_dir: symlinks and existing directories"
mkdir -p "$TMP/ed/real" "$TMP/ed/own"
ln -s "$TMP/ed/real" "$TMP/ed/link" 2>/dev/null
if [ -L "$TMP/ed/link" ] && [ "$(id -u)" != 0 ]; then
  out=$(run_hs "ensure_dir $TMP/ed/link 700 wom:wom 0" 2>&1); rc=$?
  assert_eq "a symlink owned by a non-root user is refused" 1 $rc
  assert_contains "the refusal says why" "$out" "символической ссылкой"
else skip "symlinks are not available (or running as root): the refusal is not exercised"; fi
# FIX=2 on a directory that the right owner already has: nothing is called (no chmod of a working data-root)
reset_calls
out=$(run_hs "ensure_dir $TMP/ed/own 700 \$(stat -c %U:%G $TMP/ed/own) 2" 2>&1); rc=$?
assert_eq "ensure_dir fix=2 on a correctly owned directory: exit 0" 0 $rc
assert_eq "ensure_dir fix=2 on a correctly owned directory: no chmod/chown" "" "$(calls)"

echo "root keys with command= restrictions"
printf 'no-pty,command="echo login as ubuntu" %s\n' "$KEY" > "$TMP/keys/restricted"
: > "$TMP/keys/rdst"
out=$(run_hs "merge_authorized_keys $TMP/keys/restricted $TMP/keys/rdst" 2>&1)
assert_contains "a command= key is copied with a warning" "$out" "command="

echo "daemon.json"
if command -v jq >/dev/null 2>&1; then
  out=$(run_hs "DATA_ROOT=/srv/docker; render_daemon_json /nonexistent" 2>&1); rc=$?
  assert_eq "render_daemon_json exit" 0 $rc
  assert_eq "data-root" "/srv/docker" "$(printf '%s' "$out" | jq -r '."data-root"')"
  assert_eq "log driver" "json-file" "$(printf '%s' "$out" | jq -r '."log-driver"')"
  assert_eq "log rotation" "10m/3" "$(printf '%s' "$out" | jq -r '."log-opts"."max-size" + "/" + ."log-opts"."max-file"')"
  assert_eq "address pool base/size" "10.200.0.0/12/24" "$(printf '%s' "$out" | jq -r '."default-address-pools"[0] | .base + "/" + (.size|tostring)')"
  printf '{"data-root":"/old","registry-mirrors":["https://m"]}' > "$TMP/daemon-old.json"
  out=$(run_hs "DATA_ROOT=/srv/docker; render_daemon_json $TMP/daemon-old.json" 2>&1)
  assert_eq "an existing data-root is corrected" "/srv/docker" "$(printf '%s' "$out" | jq -r '."data-root"')"
  assert_eq "foreign keys survive" "https://m" "$(printf '%s' "$out" | jq -r '."registry-mirrors"[0]')"
  printf '{broken' > "$TMP/daemon-bad.json"
  if run_hs "DATA_ROOT=/srv/docker; render_daemon_json $TMP/daemon-bad.json" >/dev/null 2>&1; then fail "invalid JSON is refused"; else pass "invalid JSON is refused"; fi
else
  skip "jq is not installed: daemon.json rendering is not checked"
fi

echo "kind"
mkdir -p "$TMP/repo/services/orchestrator"
printf 'FROM alpine\nARG KIND_VERSION=v0.99.1\nRUN true\n' > "$TMP/repo/services/orchestrator/Dockerfile"
out=$(run_hs "REPO_ROOT=$TMP/repo; detect_kind_version" 2>&1); assert_eq "kind version is read from the orchestrator Dockerfile" "v0.99.1" "$out"
out=$(run_hs "REPO_ROOT=$TMP/nowhere; detect_kind_version" 2>&1); assert_eq "kind version falls back to the runbook's" "v0.33.0" "$out"
real=$(sed -n 's/^ARG KIND_VERSION=\(v[0-9.]*\).*/\1/p' "$(cd ../.. && pwd)/services/orchestrator/Dockerfile" | head -n1)
out=$(run_hs "detect_kind_version" 2>&1); assert_eq "the real repo Dockerfile agrees" "$real" "$out"
out=$(run_hs "WOM_KIND_VERSION=v1.2.3 detect_kind_version" 2>&1); assert_eq "env override of the version" "v1.2.3" "$out"
# already installed: no download
mkdir -p "$TMP/home17/.local/bin"
printf '#!/usr/bin/env bash\necho "kind v0.33.0 go1.24 linux/amd64"\n' > "$TMP/home17/.local/bin/kind"; chmod +x "$TMP/home17/.local/bin/kind"
reset_calls
out=$(run_hs "REPO_ROOT=$TMP/nowhere; user_home(){ echo $TMP/home17; }; as_user(){ echo \"as_user \$*\" >> $TMP/asuser; \"\$@\"; }; step_kind" 2>&1); rc=$?
assert_eq "kind present: exit 0" 0 $rc
assert_contains "kind present: skipped" "$out" "уже установлен"
assert_not_contains "kind present: nothing downloaded" "$(calls)" "curl"
assert_contains "kind present: its version is asked as the service user, never as root" "$(cat "$TMP/asuser" 2>/dev/null)" "as_user $TMP/home17/.local/bin/kind version"
# download: a fake curl serves 'binary-bytes' and a checksum file; the checksum is verified
if command -v sha256sum >/dev/null 2>&1; then
  good=$(printf 'binary-bytes' | sha256sum | awk '{print $1}')
  zeros=$(printf '0%.0s' $(seq 1 64))
  mkdir -p "$TMP/home18"
  out=$(run_hs "REPO_ROOT=$TMP/nowhere; user_home(){ echo $TMP/home18; }; curl(){ fake_curl \"\$@\"; }; FAKE_SHA=$good; step_kind" 2>&1); rc=$?
  assert_eq "kind download with a matching sha256: exit 0" 0 $rc
  if [ -f "$TMP/home18/.local/bin/kind" ]; then pass "kind installed into ~/.local/bin"; else fail "kind installed into ~/.local/bin"; fi
  if modes_work; then assert_eq "kind is 755" 755 "$(stat -c %a "$TMP/home18/.local/bin/kind")"; else skip "modes not checked"; fi
  mkdir -p "$TMP/home19"
  out=$(run_hs "REPO_ROOT=$TMP/nowhere; user_home(){ echo $TMP/home19; }; curl(){ fake_curl \"\$@\"; }; FAKE_SHA=$zeros; step_kind" 2>&1); rc=$?
  assert_eq "kind download with a wrong sha256: exit 1" 1 $rc
  assert_contains "wrong sha256: says so" "$out" "sha256 kind не совпал"
  if [ -e "$TMP/home19/.local/bin/kind" ]; then fail "a binary that failed the check is not installed"; else pass "a binary that failed the check is not installed"; fi
  out=$(run_hs "REPO_ROOT=$TMP/nowhere; user_home(){ echo $TMP/home19; }; curl(){ fake_curl \"\$@\"; }; WOM_KIND_SHA256=$good; FAKE_SHA=$zeros; step_kind" 2>&1); rc=$?
  assert_eq "a pinned WOM_KIND_SHA256 overrides the published checksum" 0 $rc
else
  skip "no sha256sum: the kind checksum path is not exercised"
fi

echo "wait_for"
if run_hs 'WAIT_SLEEP=0; wait_for x 5 true' >/dev/null 2>&1; then pass "wait_for returns at once when the command succeeds"; else fail "wait_for returns at once when the command succeeds"; fi
if run_hs 'WAIT_SLEEP=0; wait_for x 0 false' >/dev/null 2>&1; then fail "wait_for gives up after the timeout"; else pass "wait_for gives up after the timeout"; fi

echo "--dry-run: a full plan and no side effects"
FSD="$TMP/dry"; mkdir -p "$FSD/root/.ssh" "$FSD/etc/ssh/sshd_config.d" "$FSD/srv"
mkos "$FSD" debian 13 trixie
printf '%s\n' "$KEY" > "$FSD/root/.ssh/authorized_keys"
printf 'Include /etc/ssh/sshd_config.d/*.conf\n' > "$FSD/etc/ssh/sshd_config"
snapshot() { (cd "$FSD" && { find . | sort; find . -type f -exec cksum {} +; }); }
before=$(snapshot)
reset_calls
dry="eval \"\$GOOD\"; FS_ROOT=$FSD; user_exists(){ return 1; }; user_home(){ echo $FSD/home/wom; }; pkg_installed(){ return 1; }; get_free_kb(){ echo 200000000; }"
out=$(run_hs "$dry; main --dry-run --data-root $FSD/srv/docker --docker-img $FSD/srv/images/docker.img --backups-dir $FSD/srv/backups --pgdata-dir $FSD/srv/pgdata" 2>&1); rc=$?
assert_eq "dry-run exit" 0 $rc
assert_eq "dry-run runs no mutating command" "" "$(calls)"
assert_eq "dry-run leaves the (fake) filesystem untouched" "$before" "$(snapshot)"
assert_contains "plan: apt packages" "$out" "apt-get install"
assert_contains "plan: jq" "$out" " jq "
assert_contains "plan: openssl" "$out" " openssl "
assert_contains "plan: iptables" "$out" " iptables "
assert_contains "plan: util-linux" "$out" " util-linux "
assert_contains "plan: the user without sudo" "$out" "useradd -m -s /bin/bash wom"
assert_contains "plan: sparse image" "$out" "truncate -s 150G $FSD/srv/images/docker.img"
assert_contains "plan: mkfs.xfs" "$out" "mkfs.xfs -q $FSD/srv/images/docker.img"
assert_contains "plan: fstab line with pquota" "$out" "loop,noatime,pquota,nofail 0 0"
assert_contains "plan: mount" "$out" "mount $FSD/srv/docker"
assert_contains "plan: ufw ssh first" "$out" "ufw allow 22/tcp"
assert_contains "plan: ufw 80" "$out" "ufw allow 80/tcp"
assert_contains "plan: ufw 443" "$out" "ufw allow 443/tcp"
assert_contains "plan: ufw enable" "$out" "ufw --force enable"
assert_contains "plan: linger" "$out" "loginctl enable-linger wom"
assert_contains "plan: sysctl files" "$out" "90-wom-keyring.conf"
assert_contains "plan: ssh hardening" "$out" "00-wom-hardening.conf"
assert_contains "plan: Docker repo key fingerprint" "$out" "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
assert_contains "plan: docker daemon.json" "$out" "daemon.json"
assert_contains "plan: slirp4netns port driver" "$out" "slirp4netns"
assert_contains "plan: rootless setup tool" "$out" "dockerd-rootless-setuptool.sh"
assert_contains "plan: kind with checksum" "$out" "sha256"
assert_contains "plan: the report" "$out" "wom-host-setup.report"
assert_contains "dry-run says nothing changed" "$out" "ничего не изменилось"
out=$(run_hs "$dry; main --dry-run --no-firewall --no-harden-ssh --data-root $FSD/srv/docker --docker-img $FSD/srv/images/docker.img --backups-dir $FSD/srv/backups --pgdata-dir $FSD/srv/pgdata" 2>&1)
assert_not_contains "--no-firewall: no ufw in the plan" "$out" "ufw allow"
assert_not_contains "--no-harden-ssh: no sshd change in the plan" "$out" "00-wom-hardening.conf"
out=$(run_hs "$dry; main --dry-run --adopt --data-root $TMP/dr1 --docker-img $FSD/srv/images/docker.img --backups-dir $FSD/srv/backups --pgdata-dir $FSD/srv/pgdata" 2>&1)
assert_not_contains "--adopt: no image is created" "$out" "mkfs.xfs"
assert_contains "--adopt: said so" "$out" "режим adopt"
out=$(run_hs "$dry; main --dry-run --data-root $TMP/dr1 --docker-img $FSD/srv/images/docker.img" 2>&1); rc=$?
assert_eq "dry-run also exits 3 on foreign data without --adopt" 3 $rc

finish
