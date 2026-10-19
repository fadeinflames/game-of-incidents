import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintBundle, loadScenarioFolder, toImportRecord } from "@wom/scenario";
import { builtImageTag, retagScenarioFolder, runWithLogTail, scrubHostPaths, submissionImageTag } from "../../src/submissions";

const node = process.execPath;

describe("runWithLogTail (submission image build)", () => {
  it("keeps only the tail of the output and reports the exit code", async () => {
    const script = "process.stdout.write('a'.repeat(200000)); process.stderr.write('THE-END'); process.exitCode = 3;";
    const r = await runWithLogTail(node, ["-e", script], { timeoutMs: 20_000, tailBytes: 1024 });
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(Buffer.byteLength(r.log)).toBeLessThanOrEqual(1024);
    expect(r.log).toContain("a");
  });

  it("stops a command that runs past the time limit", async () => {
    const t0 = Date.now();
    const r = await runWithLogTail(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300, tailBytes: 1024 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("rejects when the command cannot be started", async () => {
    await expect(runWithLogTail("wom-no-such-binary", [], { timeoutMs: 1000, tailBytes: 1024 })).rejects.toThrow();
  });
});

const created: string[] = [];
afterEach(() => void created.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const GRADER = "#!/bin/sh\nprintf '{\"passed\": true, \"criteria\": []}\\n'\n";

/** a scenario folder whose Dockerfile is built under `tag`; the k8s manifest names it twice, once with a longer tag that only starts the same */
function folder(kind: "container" | "kubernetes", tag: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wom-retag-test-"));
  created.push(dir);
  const env =
    kind === "kubernetes"
      ? `  kind: kubernetes\n  image: wom-tools:dev\n  manifests: ./k8s\n  images:\n    - ${tag}\n  build: ./image\n`
      : `  image: ${tag}\n  build: ./image\n`;
  const files: Record<string, string> = {
    "scenario.yaml": `version: 2\nslug: demo-case\ntitle: Demo case\nsummary: The service answers 502.\ntype: linux\ndifficulty: MIDDLE\ndurationMin: 20\nbrief: brief.md\ndebrief: debrief.md\nenvironment:\n${env}  break: break.sh\n  check: check.sh\n  solve: solve.sh\n`,
    "brief.md": "# Alert\n\n## Цель\n\nПочинить.\n",
    "debrief.md": "## Что было сломано\n\nПорт.\n",
    "break.sh": "#!/bin/sh\ntrue\n",
    "check.sh": GRADER,
    "solve.sh": "#!/bin/sh\ntrue\n",
    "image/Dockerfile": "FROM alpine:3.20\n",
    "k8s/app.yaml": `kind: Deployment\nspec:\n  containers:\n    - image: ${tag}\n    - image: ${tag}0\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe("a submission is built under its own image tag", () => {
  const tag = submissionImageTag("demo-case", "cmabc123");

  it("names the tag after the slug and the submission", () => {
    expect(tag).toBe("wom-scenario/demo-case:sub-cmabc123");
  });

  it("container scenario: the declared tag is replaced and the published record carries the new one", () => {
    const bundle = loadScenarioFolder(folder("container", "wom-scenario/demo-case:live"));
    expect(builtImageTag(bundle.meta.environment!)).toBe("wom-scenario/demo-case:live");
    const tagged = retagScenarioFolder(bundle, tag);
    expect(builtImageTag(tagged.meta.environment!)).toBe(tag);
    expect((toImportRecord(tagged).environmentJson as { image: string }).image).toBe(tag);
    expect(lintBundle(tagged).filter((i) => i.level === "error")).toEqual([]);
  });

  it("kubernetes scenario: the images list and the manifests follow, and a longer tag that merely starts the same is left alone", () => {
    const bundle = loadScenarioFolder(folder("kubernetes", "wom-scenario/demo-case:live"));
    const tagged = retagScenarioFolder(bundle, tag);
    expect(builtImageTag(tagged.meta.environment!)).toBe(tag);
    const record = toImportRecord(tagged).environmentJson as { images: string[]; manifests: { content: string }[] };
    expect(record.images).toEqual([tag]);
    expect(record.manifests[0].content).toContain(`image: ${tag}\n`);
    expect(record.manifests[0].content).toContain("image: wom-scenario/demo-case:live0");
    expect(readFileSync(path.join(bundle.dir, "k8s", "app.yaml"), "utf8")).not.toContain("demo-case:live\n");
  });

  it("leaves a scenario that already has the tag untouched", () => {
    const same = loadScenarioFolder(folder("container", tag));
    expect(retagScenarioFolder(same, tag)).toBe(same);
  });
});

describe("scrubHostPaths (test report for the author)", () => {
  it("hides the build directory and the docker socket but keeps the rest of the log", () => {
    const log = "ERROR: failed to read /tmp/wom-sub-Ab12Cd/ctx/Dockerfile\nCannot connect to unix:///run/user/1000/docker.sock\nRUN apt-get install foo: not found";
    const out = scrubHostPaths(log);
    expect(out).not.toContain("/tmp/wom-sub-");
    expect(out).not.toContain("/run/user/1000");
    expect(out).toContain("RUN apt-get install foo: not found");
  });

  it("hides the platform's data directories", () => {
    expect(scrubHostPaths("open /srv/docker/overlay2/abc: denied")).toBe("open <host-path>: denied");
  });
});
