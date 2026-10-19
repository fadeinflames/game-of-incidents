// A scenario folder comes out of an author's zip: a folder where a file is expected, or a file where a folder is, must end in a
// message for the author (ScenarioLoadError or a lint error), never in a raw ENOTDIR/EISDIR.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lintBundle } from "../src/lint";
import { ScenarioLoadError, loadScenarioFolder, manifestFileNames, parseScenarioContext, prepullImages, readManifests } from "../src/load";
import { cleanupFixtures, scenarioDir } from "./fixture";

afterAll(cleanupFixtures);

/** replaces a file of the fixture with a folder of the same name */
function folderInsteadOf(dir: string, rel: string) {
  rmSync(path.join(dir, rel), { recursive: true, force: true });
  mkdirSync(path.join(dir, rel), { recursive: true });
}

describe("a folder where a file is expected", () => {
  it.each(["brief.md", "break.sh", "check.sh"])("the loader refuses a folder named %s", (name) => {
    const dir = scenarioDir();
    folderInsteadOf(dir, name);
    expect(() => loadScenarioFolder(dir)).toThrowError(ScenarioLoadError);
    expect(() => loadScenarioFolder(dir)).toThrowError(/must be a file/);
  });

  it("the loader refuses a folder named scenario.yaml", () => {
    const dir = scenarioDir();
    folderInsteadOf(dir, "scenario.yaml");
    expect(() => loadScenarioFolder(dir)).toThrowError(/scenario\.yaml must be a file/);
  });

  it("the linter reports a folder named Dockerfile instead of crashing on it", () => {
    const dir = scenarioDir();
    folderInsteadOf(dir, "image/Dockerfile");
    const found = lintBundle(loadScenarioFolder(dir));
    expect(found.map((i) => i.rule)).toContain("build-dockerfile");
  });

  it("the linter reports a folder named like a manifest as no manifest", () => {
    const dir = scenarioDir({ kind: "kubernetes", files: { "k8s/app.yaml": null } });
    mkdirSync(path.join(dir, "k8s", "app.yaml"), { recursive: true });
    expect(lintBundle(loadScenarioFolder(dir)).map((i) => i.rule)).toContain("k8s-manifests");
    expect(manifestFileNames(path.join(dir, "k8s"))).toEqual([]);
    expect(readManifests(dir, "k8s")).toEqual([]);
  });
});

describe("a file where a folder is expected", () => {
  it("environment.manifests naming a file is a load error for the author", () => {
    const dir = scenarioDir({ kind: "kubernetes", files: { "k8s/app.yaml": null, "notes.txt": "x\n" }, env: { manifests: "notes.txt" } });
    const bundle = loadScenarioFolder(dir);
    expect(lintBundle(bundle).map((i) => i.rule)).toContain("k8s-manifests");
    expect(() => readManifests(dir, "notes.txt")).toThrowError(/must be a folder/);
  });

  it("environment.build naming a file is a lint error", () => {
    const dir = scenarioDir({ env: { build: "notes.txt" }, files: { "notes.txt": "x\n" } });
    expect(lintBundle(loadScenarioFolder(dir)).map((i) => i.rule)).toContain("build-dockerfile");
  });

  it("a path that runs through a file is not an exception either", () => {
    const dir = scenarioDir({ meta: { brief: "notes.txt/brief.md" }, files: { "notes.txt": "x\n" } });
    expect(lintBundle(loadScenarioFolder(dir)).map((i) => i.rule)).toContain("file-missing");
  });

  it("an empty folder without scenario.yaml is the author's mistake", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wom-scenario-empty-"));
    try {
      expect(() => loadScenarioFolder(dir)).toThrowError(/no scenario\.yaml/);
      writeFileSync(path.join(dir, "scenario.yaml"), "version: 1\n");
      expect(() => loadScenarioFolder(dir)).toThrowError(ScenarioLoadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseScenarioContext", () => {
  it("keeps what the card shows", () => {
    expect(parseScenarioContext({ infra: "k8s", setup: "до", time: "пятница", services: ["a", "b"], extra: 1 })).toEqual({ infra: "k8s", setup: "до", time: "пятница", services: ["a", "b"] });
  });

  it.each([[null], [undefined], ["text"], [42], [[1, 2]]])("gives an empty context for %j", (raw) => {
    expect(parseScenarioContext(raw)).toEqual({});
  });

  it("drops a wrong type instead of casting it", () => {
    expect(parseScenarioContext({ infra: 5, setup: ["x"], time: {}, services: "a,b" })).toEqual({});
    expect(parseScenarioContext({ services: ["a", 3, null, "", "b"] })).toEqual({ services: ["a", "b"] });
  });

  it("the card can join what comes back", () => {
    const ctx = parseScenarioContext({ services: { length: 9 } });
    expect(ctx.services?.length ?? 0).toBe(0);
  });
});

describe("prepullImages", () => {
  const env = (extra: Record<string, unknown>) => loadScenarioFolder(scenarioDir(extra)).meta.environment;

  it("names the public images and the node image of a cluster", () => {
    const e = env({ kind: "kubernetes", env: { images: ["wom-scenario/demo-case:dev", "postgres:16-alpine", "quay.io/jetstack/cert-manager-controller:v1.17.2"], cluster: { nodes: 2, nodeImage: "kindest/node:v1.31.1" } } });
    expect(prepullImages(e)).toEqual(["kindest/node:v1.31.1", "postgres:16-alpine", "quay.io/jetstack/cert-manager-controller:v1.17.2"]);
  });

  it("falls back to the default node image when the scenario names none", () => {
    expect(prepullImages(env({ kind: "kubernetes" }))).toEqual(["kindest/node:v1.37.0"]);
  });

  it("has nothing to pull for a container or a text-only scenario", () => {
    expect(prepullImages(env({}))).toEqual([]);
    expect(prepullImages(null)).toEqual([]);
  });
});
