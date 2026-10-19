# Installing Game of Incidents on your own server

Русская версия, подробная: [runbook-prod-install.md](runbook-prod-install.md), раздел «Быстрый путь». This page is the English summary of the one-command install.

## What you need

| | |
|---|---|
| Host | A clean **Debian 13 (trixie)** or **Ubuntu 24.04 LTS** machine, x86_64, cgroup v2, systemd. Dedicated or a VM. |
| Resources | Minimum 2 CPU, 8 GB RAM, 40 GB free disk. Recommended 8 CPU, 32 GB RAM. The install picks a capacity profile from the machine: on 2 CPU / 8 GB it allows 4 sessions with one Kubernetes cluster at a time (all scenarios, including the 4-node ones, fit). |
| Access | `ssh root@<host>` with a key (password-only hosts: run `ssh-copy-id root@<host>` once). |
| Ports | 22, 80, 443 reachable from outside (80 is needed for Let's Encrypt). |
| One IP, several machines | Supported: a TCP proxy routes by SNI and passes the client address with PROXY protocol; install with `--trusted-proxy <proxy address>/32`. See the runbook, "Один публичный IP на несколько машин". |
| Domain (optional) | An A record `<domain> -> <host IP>`. Without a domain the site is served at `https://<IP>` with a self-signed certificate. |
| Your machine | `bash`, `ssh`, `git`, `curl`. On Windows use Git for Windows or WSL. The repository must be cloned with the code committed (`git archive HEAD` is what gets uploaded). |

The scripts install packages, a service user `wom` (no sudo), Docker CE in **rootless** mode with a dedicated data volume, kind, a firewall (ufw: 22/80/443), unattended upgrades, and they harden ssh when root has a key. Do not run them on a machine that has other services you care about: they change the firewall and Docker. Rehearse on a VM first.

## One command

```bash
git clone https://github.com/fadeinflames/game-of-incidents.git && cd game-of-incidents
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com --dry-run
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com
```

Useful options: `--admin-user`, `--admin-email`, `--registration open|closed`, `--contact-url`, `--smoke none|linux|full`, `--dump FILE.sql.gz` (restore a database dump), `--update` (deliver new code and redeploy), `--full --yes` (run the whole path again; idempotent, secrets are never overwritten), `--ssh-key`, `--port`. `--help` lists them all.

What happens: pre-checks (ssh, OS, DNS, clean git tree) → upload of `git archive HEAD` → `host-setup.sh` as root → `app-setup.sh` as `wom` (`.env` with random secrets, systemd units, `deploy.sh`, health checks, a smoke test of one scenario) → `https://<domain>/api/health` checked from your machine. The administrator password is generated on the host and stored in `~/.wom-admin-password` (mode 600) of the `wom` user: `ssh wom@<host> cat ~/.wom-admin-password`.

Exit codes of `provision.sh`: 0 done, 1 a step failed, 2 bad arguments or a failed pre-check, 3 foreign data found in `/srv/docker` (rerun with `--adopt` if it is yours), 4 confirmation needed (`--yes`).

## After the install

- Log in as the administrator, create nothing else by hand: scenarios are seeded from `scenarios/`.
- Close registration if the site is not public: `--registration closed` and rerun with `--full --yes`.
- Backups: a nightly dump goes to `/srv/backups` (mode 700); copy it off the machine (rsync from another host). Restore steps are in the runbook (section 6).
- Update later: `git pull` on your machine, then `bash scripts/provision/provision.sh --host ... --update`.
- Outgoing connections of the platform: package repositories during install, container images, Let's Encrypt, and optionally Telegram alerts (`TG_BOT_TOKEN`) if you configure them. There is no telemetry.

## If something fails

The script stops with a message that names the step; `host-setup.sh` writes `/root/wom-host-setup.report`, `app-setup.sh` writes `~/install-report.txt`, step logs of a deploy are in `~/.cache/wom-deploy/`. Common problems (kind does not start, inotify limits, cgroup delegation, disk space, certificate) are in the runbook, section 7 (Russian). Open an issue with the report text (remove secrets).
