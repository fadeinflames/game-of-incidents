// The import record is the only thing that reaches the database (seed, POST /api/import, moderation approve): its
// environment is held to the same rules as a scenario file, and v1 records stay text-only.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImportRecordError, importFileV2Schema, importRecordSchema, publicEnvironmentSchema, v1Overwrites, validateImportRecord, type ImportRecord } from "../src";
import { loadScenarioFolder, toImportRecord } from "../src/load";

const record = (over: Record<string, unknown> = {}): ImportRecord =>
  ({
    slug: "demo-case",
    schemaVersion: 2,
    title: "Demo case",
    summary: "A scenario used by the tests.",
    type: "linux",
    difficulty: "MIDDLE",
    durationMin: 20,
    tags: [],
    contextJson: {},
    eventsJson: [],
    hintsJson: [],
    actionsJson: [],
    gmScriptJson: null,
    briefMd: null,
    debriefMd: null,
    guideMd: null,
    environmentJson: { image: "wom-scenario/demo:1" },
    breakScript: null,
    graderScript: "#!/bin/sh\n",
    solutionScript: "#!/bin/sh\n",
    ...over,
  }) as unknown as ImportRecord;

/** the paths of the issues validateImportRecord reports ([] for a valid record) */
const issues = (r: unknown): string[] => {
  try {
    validateImportRecord(r);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ImportRecordError);
    return (e as ImportRecordError).issues.map((i) => i.split(":")[0]);
  }
};

describe("importRecordSchema.environmentJson", () => {
  it("accepts a minimal environment and fills the defaults in", () => {
    const r = importRecordSchema.parse(record());
    expect(r.environmentJson).toMatchObject({ kind: "container", ttlMin: 45, writable: ["/etc", "/var", "/home", "/root"] });
  });

  it("accepts null: a text-only scenario", () => {
    expect(issues(record({ environmentJson: null, graderScript: null, solutionScript: null }))).toEqual([]);
  });

  it.each([
    ["an image that is not a reference", { image: "nginx:1.27\nprivileged: true" }, "environmentJson.image"],
    ["a node image of another repository", { image: "wom-tools:dev", cluster: { nodeImage: "evil/node:v1.37.0" } }, "environmentJson.cluster.nodeImage"],
    ["a capability with the CAP_ prefix", { image: "wom-tools:dev", capabilities: ["CAP_SYS_ADMIN"] }, "environmentJson.capabilities.0"],
    ["a memory limit above the ceiling", { image: "wom-tools:dev", resources: { memoryMb: 999999 } }, "environmentJson.resources.memoryMb"],
    ["a field the format does not know (a typo)", { image: "wom-tools:dev", ttl: 30 }, "environmentJson"],
    ["a non-normal mount path", { image: "wom-tools:dev", writable: ["/etc/../usr/bin"] }, "environmentJson.writable.0"],
    ["a manifest that is not a bare yaml file name", { image: "wom-tools:dev", manifests: [{ name: "../../etc/passwd", content: "x" }] }, "environmentJson.manifests.0.name"],
    ["a script reference of the file format", { image: "wom-tools:dev", check: "check.sh" }, "environmentJson"],
  ])("rejects %s", (_label, environmentJson, issuePath) => {
    expect(issues(record({ environmentJson }))).toContain(issuePath);
  });

  it("rejects an environment that is not an object", () => {
    expect(issues(record({ environmentJson: "image: x" }))).toEqual(["environmentJson"]);
  });
});

describe("R-4 on the import path", () => {
  it.each([
    ["a writable volume over /usr", { writable: ["/usr/local"] }, "environmentJson.writable.0"],
    ["a writable volume over /bin", { writable: ["/etc", "/bin"] }, "environmentJson.writable.1"],
    ["a writable root", { writable: ["/"] }, "environmentJson.writable.0"],
    ["a tmpfs over /lib", { tmpfs: { "/lib": "size=64m" } }, "environmentJson.tmpfs./lib"],
    ["a tmpfs under /usr", { tmpfs: { "/usr/share": "size=64m" } }, "environmentJson.tmpfs./usr/share"],
  ])("rejects %s", (_label, env, issuePath) => {
    expect(issues(record({ environmentJson: { image: "wom-tools:dev", ...env } }))).toContain(issuePath);
  });

  it.each([["/usr"], ["/dev"], ["/proc/sys"]])("refuses %s as a mount", (p) => {
    expect(publicEnvironmentSchema.safeParse({ image: "wom-tools:dev", writable: [p] }).success).toBe(false);
  });

  it("allows what scenarios really use, and a path that only starts like a binary directory", () => {
    const env = { image: "wom-tools:dev", writable: ["/etc", "/var", "/home", "/opt/app", "/usrlocal"], tmpfs: { "/var/log": "size=16m", "/tmp": "size=64m" } };
    expect(publicEnvironmentSchema.safeParse(env).success).toBe(true);
  });
});

describe("importRecordSchema: the rest of the record", () => {
  it("holds the hints of a v2 record to the hint schema", () => {
    expect(issues(record({ hintsJson: [{ level: 1, text: "ok enough text" }] }))).toEqual([]);
    expect(issues(record({ hintsJson: [{ text: "no level here" }] }))).toEqual(["hintsJson.0.level"]);
    expect(issues(record({ hintsJson: [{ level: 1, text: "x" }] }))).toEqual(["hintsJson.0.text"]);
  });

  it("limits tags like the scenario file does", () => {
    expect(issues(record({ tags: ["Has Space"] }))).toEqual(["tags.0"]);
    expect(issues(record({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toEqual(["tags"]);
  });

  it("keeps a v1 record text-only: no environment, no scripts", () => {
    const v1 = { schemaVersion: 1, environmentJson: null, graderScript: null, solutionScript: null, hintsJson: [{ whatever: true }] };
    expect(issues(record(v1))).toEqual([]);
    expect(issues(record({ ...v1, environmentJson: { image: "wom-tools:dev" } }))).toEqual(["environmentJson"]);
    expect(issues(record({ ...v1, graderScript: "#!/bin/sh\n" }))).toEqual(["graderScript"]);
  });

  it("an import file is only as good as its records", () => {
    const bad = record({ environmentJson: { image: "wom-tools:dev", writable: ["/usr"] } });
    expect(importFileV2Schema.safeParse({ version: 2, scenarios: [record(), bad] }).success).toBe(false);
    expect(importFileV2Schema.safeParse({ version: 2, scenarios: [record()] }).success).toBe(true);
  });
});

describe("v1Overwrites", () => {
  const v1 = (slug: string) => record({ slug, schemaVersion: 1, environmentJson: null });

  it("names the v1 records whose slug is a live v2 scenario", () => {
    const existing = [
      { slug: "cert-expired", schemaVersion: 2 },
      { slug: "old-text-case", schemaVersion: 1 },
    ];
    expect(v1Overwrites([v1("cert-expired"), v1("old-text-case"), v1("brand-new")], existing)).toEqual(["cert-expired"]);
  });

  it("leaves v2 records alone: a v2 re-import is the normal way to update", () => {
    expect(v1Overwrites([record({ slug: "cert-expired" })], [{ slug: "cert-expired", schemaVersion: 2 }])).toEqual([]);
  });
});

describe("the scenarios in the repository", () => {
  const root = path.resolve(__dirname, "../../../scenarios");
  const dirs = readdirSync(root).filter((d) => existsSync(path.join(root, d, "scenario.yaml")));

  it("are found", () => {
    expect(dirs.length).toBeGreaterThan(10);
  });

  it.each(dirs)("%s passes the gate in front of the database", (dir) => {
    const r = toImportRecord(loadScenarioFolder(path.join(root, dir)));
    expect(issues(r)).toEqual([]);
  });
});
