# Game of Incidents

Русская версия: [README.md](README.md) (основная).

Game of Incidents is a browser platform for incident training. You open a scenario, press **Run**, and get a terminal into an isolated, deliberately broken environment (a Linux host or your own Kubernetes cluster). You fix it and press **Check**. The grader looks at the result, not at the way you got there; after the fix you get a debrief with the reference solution.

- **22 scenarios** (3 Linux, 19 Kubernetes on kind), five junior ones with a tutorial copy that unlocks diagnostic stages one by one.
- **Real environments, not quizzes**: every session gets its own sandbox (a hardened rootless Docker container, or a kind cluster per session).
- **Self-hosted**: one command installs the whole platform on a clean Debian 13 or Ubuntu 24.04 host.
- **Open scenarios**: a scenario is a folder (`scenario.yaml`, brief, debrief, `break.sh`, `check.sh`, `solve.sh`); you can write your own and submit it through the web UI or a pull request.

Status: before 1.0. The UI and most documentation are in Russian; this file, [CONTRIBUTING.en.md](CONTRIBUTING.en.md), [SECURITY.en.md](SECURITY.en.md) and [docs/install.en.md](docs/install.en.md) are the English entry points.

> **Security warning.** The platform runs untrusted player actions. In Kubernetes scenarios the player is cluster-admin of a kind cluster whose nodes are privileged containers in the same rootless Docker daemon as the platform. Install it on a dedicated host or VM and read [SECURITY.en.md](SECURITY.en.md) before opening registration to strangers.

![Landing page of Game of Incidents with a terminal walkthrough of a solved case](docs/images/landing.png)

**Try it without installing:** https://game.sresh.ru — the maintainer's public instance, open registration (login and password, no e-mail).

## Install on your own server

You need a clean host with **Debian 13 or Ubuntu 24.04 LTS** (root access over an ssh key; at least 2 CPU, 8 GB RAM, 40 GB free; 8 CPU / 32 GB recommended for many parallel Kubernetes sessions) and, for a real site, a domain whose A record points at the host.

```bash
git clone https://github.com/fadeinflames/game-of-incidents.git
cd game-of-incidents
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com --dry-run   # print the plan
bash scripts/provision/provision.sh --host 203.0.113.10 --domain game.example.com             # do it
```

No domain? Pass only `--host <IPv4>`: the site is served at `https://<IP>` with a self-signed certificate (good for a trial, a lab network or a rehearsal). Full guide: [docs/install.en.md](docs/install.en.md).

## Develop locally

Linux (or WSL2 / a VM), Node 22, rootless Docker, GNU Make. See the section "Локальная разработка" of [README.md](README.md); in short:

```bash
cp .env.example .env     # set INTERNAL_TOKEN (openssl rand -hex 32) and DOCKER_SOCKET_PATH
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock   # the rootless sandbox daemon; Kubernetes scenarios also need `kind` in PATH
make install && make scenarios && make db-up && make db-migrate seed
make dev-orchestrator    # terminal 1
make dev-web             # terminal 2 -> http://localhost:3000, login demo / demo1234 (development only)
```

Checks: `make verify` (types, all tests with a throwaway PostgreSQL, shell checks).

## Repository layout

```
apps/web/               Next.js 16: catalogue, scenario page, session terminal (xterm.js), history, author area, admin
services/orchestrator/  Node 22 + TypeScript: sessions, quotas, cluster queue, terminal gateway, grader
packages/db/            Prisma 6 schema, migrations, seed
packages/runtime/       Docker and kind runtime providers (+ a fake one for tests)
packages/scenario/      scenario format v2, loader, linter, regression runner, the `wom` CLI
scenarios/<slug>/       the scenarios
images/  deploy/  scripts/  schemas/  agent-skill/  docs/
```

## Licences

- Platform code: [Apache License 2.0](LICENSE).
- Scenarios and documentation: [CC BY 4.0](LICENSE-CONTENT.md).
- Third-party components and attribution: [NOTICE](NOTICE).

"Kubernetes", "Docker", "PostgreSQL" and other product names belong to their owners; this project is not affiliated with them.

## Contributing and contact

[CONTRIBUTING.en.md](CONTRIBUTING.en.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · [SECURITY.en.md](SECURITY.en.md) · maintainer: https://t.me/fadeinflames
