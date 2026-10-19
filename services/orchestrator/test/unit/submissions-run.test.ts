// SubmissionRunner.run from the archive to the verdict: unzip, lint, the scenario regression on a fake runtime, the rows
// written. The scenario has no Dockerfile, so no `docker build` is started. A stubbed database, no PostgreSQL, no Docker.
import { readdirSync } from "node:fs";
import os from "node:os";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionStatus, type PrismaClient } from "@wom/db";
import { FakeRuntimeProvider } from "@wom/runtime";
import { logger } from "../../src/logger";
import { SubmissionRunner, type SubmissionHost } from "../../src/submissions";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PASS = '{"passed":true,"criteria":[{"id":"http","ok":true,"message":"200"}]}';
const FAIL = '{"passed":false,"criteria":[{"id":"http","ok":false,"message":"502"}]}';

const files: Record<string, string> = {
  "scenario.yaml":
    "version: 2\nslug: run-case\ntitle: Run case\nsummary: The service answers 502.\ntype: linux\ndifficulty: MIDDLE\ndurationMin: 20\nbrief: brief.md\ndebrief: debrief.md\nenvironment:\n  image: wom-scenario/run-case:v1\n  break: break.sh\n  check: check.sh\n  solve: solve.sh\n",
  "brief.md": "# Alert\n\n## Цель\n\nПочинить.\n",
  "debrief.md": "## Что было сломано\n\nПорт.\n",
  "break.sh": "#!/bin/sh\n# BREAK\ntrue\n",
  // the lint wants a grader that prints a verdict; the fake sandbox answers with its own, found by the marker
  "check.sh": `#!/bin/sh\n# CHECK\nprintf '{"passed": true, "criteria": [{"id": "http", "ok": true}]}\\n'\n`,
  "solve.sh": "#!/bin/sh\n# SOLVE\ntrue\n",
};
const archive = (over: Record<string, string> = {}) => zipSync(Object.fromEntries(Object.entries({ ...files, ...over }).map(([k, v]) => [k, strToU8(v)])));

/** a sandbox that behaves like the scenario: broken by break.sh, repaired by solve.sh (or not, when `repairs` is false) */
function runtimeFor(opts: { repairs: boolean }) {
  const rt = new FakeRuntimeProvider();
  let broken = false;
  rt.scriptResponder = (script) => {
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (script.includes("# BREAK")) return (broken = true), ok;
    if (script.includes("# SOLVE")) return (broken = !opts.repairs), ok;
    if (script.includes("# CHECK")) return { ...ok, stdout: broken ? FAIL : PASS };
    if (script.includes(".wom-probe")) return { ...ok, stdout: "touch: /usr/bin/.wom-probe: Read-only file system\nrc=1\n" };
    if (script.includes("command -v apt-get")) return { ...ok, stdout: "done\n" };
    return ok;
  };
  return rt;
}

function prismaFor(status: SubmissionStatus = SubmissionStatus.UPLOADED, zip: Uint8Array = archive()) {
  const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const row = { id: "sub1", slug: "run-case", status, archive: Buffer.from(zip), authorId: "u1" };
  const prisma = {
    scenarioSubmission: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => (writes.push({ where: { id: "sub1" }, data: args.data }), row)),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => (writes.push(args), { count: 1 })),
    },
  };
  return { db: prisma as unknown as PrismaClient, writes, prisma };
}

const host = (): SubmissionHost => ({ assertHostReady: vi.fn(async () => {}), withProvisioningSlot: (_key, fn) => fn() });

/** the regression sleeps (a second and a half for services to start, polls while a verdict lags): fake time keeps the test quick */
async function run(runner: SubmissionRunner) {
  vi.useFakeTimers();
  const done = runner.run("sub1");
  await vi.runAllTimersAsync();
  await done;
  vi.useRealTimers();
}

const tmpLeft = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith("wom-sub-"));

describe("SubmissionRunner.run: the whole way", () => {
  it("a scenario whose regression passes ends PASSED with the report and the record that was tested", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    const before = tmpLeft();
    const { db, writes } = prismaFor();
    const rt = runtimeFor({ repairs: true });
    const h = host();
    await run(new SubmissionRunner(db, rt, { dockerSocket: "/nonexistent", host: h }));

    expect(h.assertHostReady).toHaveBeenCalledWith("docker");
    expect(writes[0].data).toMatchObject({ status: SubmissionStatus.TESTING });
    const verdict = writes.at(-1)!;
    expect(verdict.where).toEqual({ id: "sub1", status: SubmissionStatus.TESTING }); // only while the row is still TESTING
    expect(verdict.data.status).toBe(SubmissionStatus.PASSED);
    const report = verdict.data.testReport as { ok: boolean; steps: { name: string; ok: boolean }[] };
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(
      expect.arrayContaining(["break.sh exits 0", "grader fails on broken sandbox", "solve.sh exits 0", "grader passes after reference solution", "rootfs read-only", "no package managers"]),
    );
    expect(verdict.data.record).toMatchObject({ slug: "run-case", graderScript: expect.stringContaining("# CHECK") });
    expect(rt.sandboxes.size).toBe(0); // every stand of the run is gone
    expect(tmpLeft()).toEqual(before); // and so is the unpacked archive
  });

  it("a reference solution that does not repair the stand ends FAILED, and the report says which step", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    const { db, writes } = prismaFor();
    const rt = runtimeFor({ repairs: false });
    await run(new SubmissionRunner(db, rt, { dockerSocket: "/nonexistent", host: host() }));
    const verdict = writes.at(-1)!;
    expect(verdict.data.status).toBe(SubmissionStatus.FAILED);
    const steps = (verdict.data.testReport as { steps: { name: string; ok: boolean; detail: string }[] }).steps;
    expect(steps.find((s) => s.name === "grader passes after reference solution")).toMatchObject({ ok: false, detail: expect.stringContaining("http (502)") });
    expect(rt.sandboxes.size).toBe(0);
  });

  it("an archive that does not pass the lint never starts a stand", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
    const { db, writes } = prismaFor(SubmissionStatus.UPLOADED, archive({ "check.sh": "#!/bin/sh\n# CHECK\ntrue\n" }));
    const rt = runtimeFor({ repairs: true });
    const h = host();
    await run(new SubmissionRunner(db, rt, { dockerSocket: "/nonexistent", host: h }));
    expect(writes.at(-1)!.data.status).toBe(SubmissionStatus.FAILED);
    expect(JSON.stringify(writes.at(-1)!.data.testReport)).toContain("lint");
    expect(h.assertHostReady).not.toHaveBeenCalled();
    expect(rt.sandboxes.size).toBe(0);
  });

  it.each([SubmissionStatus.TESTING, SubmissionStatus.APPROVED, SubmissionStatus.REJECTED, SubmissionStatus.LINT_FAILED])(
    "a submission that is %s is not tested: a decided or running one is left as it is",
    async (status) => {
      const { db, writes } = prismaFor(status);
      await run(new SubmissionRunner(db, runtimeFor({ repairs: true }), { dockerSocket: "/nonexistent", host: host() }));
      expect(writes).toEqual([]);
    },
  );

  it("a submission that no longer exists is ignored", async () => {
    const { db, prisma, writes } = prismaFor();
    prisma.scenarioSubmission.findUnique.mockResolvedValue(null as never);
    await run(new SubmissionRunner(db, runtimeFor({ repairs: true }), { dockerSocket: "/nonexistent", host: host() }));
    expect(writes).toEqual([]);
  });
});
