import { afterAll, describe, expect, it } from "vitest";
import { ALLOWED_BASE_IMAGES, disallowedDockerfileImages, lintBundle } from "../src/lint";
import { ScenarioLoadError, loadScenarioFolder, toImportRecord } from "../src/load";
import { MAX_TEXT_CHARS, importRecordSchema } from "../src/schema";
import { cleanupFixtures, scenarioDir, type FixtureOptions } from "./fixture";

afterAll(cleanupFixtures);

const load = (opts: FixtureOptions = {}) => loadScenarioFolder(scenarioDir(opts));
const rules = (opts: FixtureOptions = {}, level?: "error" | "warning") =>
  lintBundle(load(opts))
    .filter((i) => !level || i.level === level)
    .map((i) => i.rule);
const issuesOf = (opts: FixtureOptions) => {
  try {
    load(opts);
  } catch (e) {
    if (e instanceof ScenarioLoadError) return e.issues.join("\n");
    throw e;
  }
  return "";
};

describe("nested objects of scenario.yaml are strict", () => {
  it.each([
    ["resources", { resources: { cpus: 1, memoryMB: 4096 } }, /environment\.resources/],
    ["network", { network: { egres: "none" } }, /environment\.network/],
    ["shell", { shell: { user: "oncall", sudoo: true } }, /environment\.shell/],
    ["cluster", { kind: "kubernetes", cluster: { nodes: 2, nodeimage: "kindest/node:v1.37.0" } }, /environment\.cluster/],
    ["services", { services: [{ name: "app", port: 80, protocol: "http" }] }, /environment\.services/],
    ["artifacts", { artifacts: [{ src: "a", dest: "/b", mode: "0644" }] }, /environment\.artifacts/],
  ])("a misspelt key in %s is an error, not a silent default", (_name, env, where) => {
    expect(issuesOf({ env: env as Record<string, unknown> })).toMatch(where);
  });

  it("a misspelt key in a hint or in test is an error", () => {
    expect(issuesOf({ meta: { hintsJson: [{ level: 1, text: "Направление", penalti: 3 }] } })).toMatch(/hintsJson/);
    expect(issuesOf({ meta: { test: { baseline: "pass", baselin: "fail" } } })).toMatch(/test/);
  });

  it("the right spellings still load", () => {
    expect(() => load({ env: { resources: { cpus: 1, memoryMb: 512, pids: 64 }, network: { egress: "none", allow: [] }, shell: { user: "oncall", sudo: true } } })).not.toThrow();
  });

  it("a stored record with a stray key in the environment is refused too", () => {
    const record = toImportRecord(load());
    const bad = { ...record, environmentJson: { ...record.environmentJson!, resources: { cpus: 1, memoryMB: 9 } } };
    expect(importRecordSchema.safeParse(bad).success).toBe(false);
    expect(importRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe("what the platform does not read is said so", () => {
  it("environment.artifacts is an error: nothing copies the files", () => {
    expect(rules({ env: { artifacts: [{ src: "data.txt", dest: "/srv/data.txt" }] } }, "error")).toEqual(["artifacts-unsupported"]);
  });

  it("environment.services is a warning: it is still on the shelf of existing scenarios", () => {
    expect(rules({ env: { services: [{ name: "app", port: 8080, kind: "http" }] } })).toEqual(["services-unsupported"]);
    expect(rules({ env: { services: [] } })).toEqual([]);
  });
});

describe("sizes that get into the database", () => {
  const big = "x".repeat(MAX_TEXT_CHARS + 1);

  it.each([
    ["brief", { "brief.md": big }],
    ["debrief", { "debrief.md": big }],
    ["break.sh", { "break.sh": `#!/bin/sh\n# ${big}\n` }],
    ["check.sh", { "check.sh": `#!/bin/sh\n# ${big}\nprintf '{"passed": true, "criteria": []}'\n` }],
    ["solve.sh", { "solve.sh": `#!/bin/sh\n# ${big}\n` }],
  ])("%s above the limit is a lint error", (_name, files) => {
    expect(rules({ files }, "error")).toEqual(["text-too-large"]);
  });

  it("a guide above the limit is a lint error", () => {
    expect(rules({ meta: { guide: "guide.md" }, files: { "guide.md": `## Этап\n\n${big}\n` } }, "error")).toEqual(["text-too-large"]);
  });

  it("the free-form JSON of scenario.yaml has a limit too", () => {
    expect(rules({ meta: { contextJson: { note: "y".repeat(300 * 1024) } } }, "error")).toEqual(["text-too-large"]);
  });

  it("a text at the limit is fine", () => {
    expect(rules({ files: { "brief.md": `# Alert\n\n## Цель\n\n${"x".repeat(MAX_TEXT_CHARS - 40)}\n` } }, "error")).toEqual([]);
  });

  it("manifests above 4 MB in total are an error", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i++) files[`k8s/big-${i}.yaml`] = `# ${"x".repeat(1.5 * 1024 * 1024)}\nkind: Namespace\nmetadata: { name: n${i} }\n`;
    expect(rules({ kind: "kubernetes", files }, "error")).toEqual(["manifests-size"]);
  });

  it("the import gate refuses an oversized text whatever route it took", () => {
    const record = toImportRecord(load());
    expect(importRecordSchema.safeParse({ ...record, briefMd: big }).success).toBe(false);
    expect(importRecordSchema.safeParse({ ...record, graderScript: big }).success).toBe(false);
    expect(importRecordSchema.safeParse({ ...record, briefMd: "x".repeat(MAX_TEXT_CHARS) }).success).toBe(true);
  });
});

describe("the shape of contextJson", () => {
  it("warns about what the scenario card would skip", () => {
    expect(rules({ meta: { contextJson: { infra: 5 } } }, "warning")).toEqual(["context-shape"]);
    expect(rules({ meta: { contextJson: { services: "a,b" } } }, "warning")).toEqual(["context-shape"]);
    expect(rules({ meta: { contextJson: { services: ["a", 2] } } }, "warning")).toEqual(["context-shape"]);
  });

  it("is quiet for the shape the card reads", () => {
    expect(rules({ meta: { contextJson: { infra: "k8s", setup: "до", time: "пятница", services: ["a"], other: { any: 1 } } } })).toEqual([]);
  });
});

describe("base images", () => {
  it("alpine 3.22 is allowed next to the older tag authors already use", () => {
    expect(ALLOWED_BASE_IMAGES).toEqual(expect.arrayContaining(["alpine:3.22", "alpine:3.20"]));
    expect(disallowedDockerfileImages("FROM alpine:3.22\n")).toEqual([]);
  });

  it("another alpine is still refused", () => {
    expect(disallowedDockerfileImages("FROM alpine:3.21\n")).toEqual(["alpine:3.21"]);
    expect(disallowedDockerfileImages("FROM alpine\n")).toEqual(["alpine"]);
  });
});
