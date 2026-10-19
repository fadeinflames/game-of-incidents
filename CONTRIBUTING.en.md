# Contributing

Русская версия: [CONTRIBUTING.md](CONTRIBUTING.md).

Thanks for helping with Game of Incidents. We welcome fixes, platform improvements, documentation and **new scenarios**.

## Licences of contributions

The platform code is under the Apache License 2.0 ([LICENSE](LICENSE)). Scenarios (`scenarios/`) and documentation (`docs/`) are under CC BY 4.0, and the scripts and images inside scenarios also under Apache-2.0 ([LICENSE-CONTENT.md](LICENSE-CONTENT.md)). By opening a pull request you agree to these licences for your contribution. No `Signed-off-by` is required. Do not submit other people's code or text without permission, and keep secrets and real-system data out of your contribution.

## Getting started

1. For a large change, open an issue first. Small fixes can go straight to a pull request.
2. Fork, branch from `main`, make small commits. Commit messages: type and scope in English (`fix(orchestrator): ...`, `feat(web): ...`, `docs: ...`, `test: ...`) and a meaningful body.
3. Run the checks below and say in the pull request what you verified.

## Development environment

You need Linux (or WSL2 / a VM on Windows and macOS), Node 22, Docker (a rootless daemon for sandboxes) and GNU Make. Details and commands are in [README.md](README.md) (in Russian), section "Локальная разработка"; the short English summary is in [README.en.md](README.en.md). The platform does not run without Linux and Docker, but most unit tests do.

The shortest way to install the whole platform on a clean server: [docs/runbook-prod-install.md](docs/runbook-prod-install.md) ("Быстрый путь", `scripts/provision/provision.sh`; see also [docs/install.en.md](docs/install.en.md)).

## Checks before a pull request

```bash
npm ci
make typecheck          # types of all packages
make verify             # types, all tests with a throwaway PostgreSQL, bash -n and shellcheck (needs Docker)
```

Without Docker, run at least the unit tests:

```bash
npm -w @wom/runtime test && npm -w @wom/scenario test && npm -w @wom/web test && npm -w @wom/orchestrator run test:unit
bash scripts/test/run.sh   # tests of the install and deploy scripts
```

For scenarios: `npx wom scenario lint scenarios/<name>` and `npx wom scenario test scenarios/<name>` (needs Docker; the regression checks that a fresh stand is unsolved and the reference solution solves it).

CI checks pull requests in the same spirit but without a database; `make verify` remains the deciding check.

## Adding a scenario

A scenario is a folder `scenarios/<slug>/`: `scenario.yaml`, `brief.md`, `debrief.md`, `image/Dockerfile` (or `k8s/`), `break.sh`, `check.sh`, `solve.sh`. Format: [ADR-0005](docs/adr/0005-scenario-format-v2.md); example: `scenarios/nginx-502-upstream`. Rules:

- the grader checks the **state of the system**, not the way it was fixed;
- no real companies, people, addresses or secrets; passwords of the training stand are fictional;
- the author of a scenario is credited in `NOTICE` (and in the debrief if you like); by submitting a scenario you agree to CC BY 4.0, and Apache-2.0 for its scripts;
- `wom scenario lint` and `wom scenario test` pass.

To generate a scenario folder from an incident description, use the LLM instructions in `agent-skill/wom-scenario-author/SKILL.md`.

Ways to submit a scenario:

- a **pull request** with the folder `scenarios/<slug>/` into this repository — for the shared catalogue; the maintainer runs the regression;
- the **author cabinet** of any platform installation ("Мои сценарии", a zip of the folder) — the moderator of that installation checks and publishes it;
- `wom scenario push scenarios/<slug> --url https://<platform>` — the same through the CLI (login and password in `WOM_USER` and `WOM_PASSWORD`).

An idea without a folder is welcome through the "Scenario idea" issue template.

## Good to know

- The names `wom`, `@wom/*`, `wom_*` and the `wom` CLI are historical internal identifiers. The product is called Game of Incidents; renaming the internals is postponed so as not to break existing installations.
- UI messages and most documentation are in Russian; code, identifiers and commits are in English. English versions of the main documents are welcome.
- The platform runs untrusted code. Changes to isolation, networks, permissions and the grader get extra review; report vulnerabilities privately, see [SECURITY.en.md](SECURITY.en.md).

## Maintainers and decisions

The project is maintained by Maxim Gusev (GitHub `fadeinflames`, https://t.me/fadeinflames). Architecture decisions are recorded as ADRs in [docs/adr/](docs/adr/README.md). The maintainer may decline a contribution that does not fit the direction of the project and explains why.

Behaviour in the project is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
