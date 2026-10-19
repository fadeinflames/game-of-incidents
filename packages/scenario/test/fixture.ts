// Builds a throwaway scenario folder for linter/loader tests; `files` overrides or adds files, null removes one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const GRADER = `#!/bin/sh\nprintf '{"passed": true, "criteria": []}\\n'\n`;

const meta = {
  version: 2,
  slug: "demo-case",
  title: "Demo case",
  summary: "The service answers 502 after a config change.",
  type: "linux, nginx",
  difficulty: "MIDDLE",
  durationMin: 20,
  hintsJson: [
    { level: 1, penalty: 0, text: "Направление: посмотри логи." },
    { level: 2, penalty: 5, text: "Инструмент: journalctl." },
    { level: 3, penalty: 15, text: "Почти ответ: порт апстрима." },
  ],
  brief: "brief.md",
  debrief: "debrief.md",
};

const containerEnv = { kind: "container", image: "wom-scenario/demo-case:dev", build: "./image", break: "break.sh", check: "check.sh", solve: "solve.sh" };
const kubernetesEnv = {
  kind: "kubernetes",
  image: "wom-tools:dev",
  manifests: "./k8s",
  images: ["wom-scenario/demo-case:dev"],
  build: "./image",
  break: "break.sh",
  check: "check.sh",
  solve: "solve.sh",
  shell: { user: "oncall", cwd: "/home/oncall", shell: "/bin/bash", sudo: true },
};

const baseFiles: Record<string, string> = {
  "brief.md": "# Alert\n\n## Цель\n\nПочинить.\n",
  "debrief.md": "## Что было сломано\n\nПорт.\n",
  "break.sh": "#!/bin/sh\ntrue\n",
  "check.sh": GRADER,
  "solve.sh": "#!/bin/sh\ntrue\n",
  "image/Dockerfile": "FROM debian:bookworm-slim\nRUN rm -f /usr/bin/apt /usr/bin/dpkg\n",
};
const kubernetesFiles: Record<string, string> = {
  ...baseFiles,
  "check.sh": `#!/bin/sh\nkubectl get deploy web >/dev/null\nprintf '{"passed": true, "criteria": []}\\n'\n`,
  "solve.sh": "#!/bin/sh\nkubectl rollout restart deploy/web\n",
  "image/Dockerfile": "FROM python:3.12-alpine\n",
  "k8s/app.yaml": "apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: wom-scenario/demo-case:dev\n          resources:\n            requests: { cpu: 50m, memory: 64Mi }\n            limits: { memory: 128Mi }\n",
};

const created: string[] = [];

export type FixtureOptions = {
  kind?: "container" | "kubernetes";
  meta?: Record<string, unknown>;
  env?: Record<string, unknown>;
  files?: Record<string, string | null>;
};

export function scenarioDir(opts: FixtureOptions = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wom-scenario-test-"));
  created.push(dir);
  const k8s = opts.kind === "kubernetes";
  const doc = { ...meta, ...opts.meta, environment: { ...(k8s ? kubernetesEnv : containerEnv), ...opts.env } };
  const files: Record<string, string | null> = { ...(k8s ? kubernetesFiles : baseFiles), "scenario.yaml": YAML.stringify(doc), ...opts.files };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
