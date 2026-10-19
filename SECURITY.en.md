# Security policy

Русская версия: [SECURITY.md](SECURITY.md).

## Reporting a vulnerability

Do not open a public issue. Use one of:

1. **GitHub Security Advisories** of this repository: Security tab → "Report a vulnerability" (a private report).
2. A direct message to the maintainer on Telegram: https://t.me/fadeinflames (only "I have a vulnerability, how do I send the details"; send the details after a reply, in a private report).

Please include: the version or commit, steps to reproduce, the impact (sandbox escape, reading other people's data, bypassed checks, denial of service) and a way to reach you. We reply within 7 days and give a fix plan or a reason for declining within 30 days. A fixed vulnerability is disclosed after the fix is released; the reporter is credited unless they prefer otherwise.

## In scope

- escape from a sandbox (a Linux scenario container or a kind node) to the host or to other sessions;
- bypassing network isolation or the `egress-guard` policy;
- access to another person's session, data, terminal or grader; privilege escalation to moderator or admin;
- running or building a scenario without the moderator's approval;
- leaking platform secrets (`INTERNAL_TOKEN`, the database password, tokens).

UI bugs, scenario inaccuracies and documentation issues are not vulnerabilities: open a regular issue.

## Threat-model warning

The platform runs **untrusted player actions** in sandboxes. Linux scenarios run in hardened rootless Docker containers. In Kubernetes scenarios the player is cluster-admin of their own kind cluster, and a kind node is a privileged container in the same rootless daemon as the platform; this boundary is weaker than the others (risk R-6 in [docs/threat-model.md](docs/threat-model.md), in Russian).

- Install on a **dedicated host or VM**, away from data you cannot lose.
- Do not open registration to an unknown public without understanding this risk. The default install keeps registration open; close it with `--registration closed` (see [docs/runbook-prod-install.md](docs/runbook-prod-install.md)).
- Scenarios uploaded by other people run only after a moderator has reviewed them. Do not approve a scenario whose scripts you have not read.

## Supported versions

Before 1.0, fixes are released for the latest `main` commit and the latest tag only.
