// A moderator's test run of a submission goes through the same host checks and provisioning slots as a player's session,
// cannot hang the queue, and cannot stay in TESTING. Stubbed database, fake runtime, no Docker.
import os from "node:os";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionStatus, type PrismaClient } from "@wom/db";
import { FakeRuntimeProvider, type SandboxSpec } from "@wom/runtime";
import { logger } from "../../src/logger";
import { QuotaError } from "../../src/sessions";
import { guardedRuntime, SubmissionRunner, type SubmissionHost } from "../../src/submissions";

afterEach(() => vi.restoreAllMocks());

const quiet = () => [vi.spyOn(logger, "info").mockImplementation(() => {}), vi.spyOn(logger, "warn").mockImplementation(() => {}), vi.spyOn(logger, "error").mockImplementation(() => {})];

const spec = (kubernetes: boolean): SandboxSpec =>
  ({ image: "x", writable: [], tmpfs: {}, capAdd: [], sudo: false, resources: { cpus: 1, memoryMb: 64, pids: 64 }, labels: {}, ...(kubernetes ? { kubernetes: { nodes: 1, nodeImage: "n", manifests: [], images: [] } } : {}) }) as SandboxSpec;

function host(over: Partial<SubmissionHost> = {}) {
  const slots: string[] = [];
  const h: SubmissionHost = {
    assertHostReady: vi.fn(async () => {}),
    withProvisioningSlot: vi.fn(async (key, fn) => {
      slots.push(key);
      return fn();
    }),
    ...over,
  };
  return { host: h, slots };
}

describe("guardedRuntime", () => {
  it("a docker stand: the host check runs, no cluster slot is taken", async () => {
    const { host: h, slots } = host();
    const rt = new FakeRuntimeProvider();
    await guardedRuntime(rt, h, "submission-a").create(spec(false));
    expect(h.assertHostReady).toHaveBeenCalledWith("docker");
    expect(slots).toEqual([]);
    expect(rt.sandboxes.size).toBe(1);
  });

  it("a kubernetes stand: the host check runs for kubernetes and the cluster is created inside a provisioning slot", async () => {
    const { host: h, slots } = host();
    const rt = new FakeRuntimeProvider();
    const create = vi.spyOn(rt, "create");
    await guardedRuntime(rt, h, "submission-a").create(spec(true));
    expect(h.assertHostReady).toHaveBeenCalledWith("kubernetes");
    expect(slots).toEqual(["submission-a:1"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a refused host check (disk, egress guard) means nothing is created and no slot is taken", async () => {
    const { host: h, slots } = host({ assertHostReady: vi.fn(async () => Promise.reject(new QuotaError("заканчивается место на диске"))) });
    const rt = new FakeRuntimeProvider();
    await expect(guardedRuntime(rt, h, "submission-a").create(spec(true))).rejects.toBeInstanceOf(QuotaError);
    expect(slots).toEqual([]);
    expect(rt.sandboxes.size).toBe(0);
  });

  it("every stand of the run takes its own slot (the regression creates one before the break and one after)", async () => {
    const { host: h, slots } = host();
    const g = guardedRuntime(new FakeRuntimeProvider(), h, "submission-a");
    await g.create(spec(true));
    await g.create(spec(true));
    expect(slots).toEqual(["submission-a:1", "submission-a:2"]);
  });
});

const SCENARIO = (kind: "container" | "kubernetes") => {
  const env = kind === "kubernetes" ? "  kind: kubernetes\n  image: wom-tools:dev\n  manifests: ./k8s\n  images:\n    - wom-scenario/demo-case:v1\n  build: ./image\n" : "  image: wom-scenario/demo-case:v1\n  build: ./image\n";
  const grader = "#!/bin/sh\nprintf '{\"passed\": true, \"criteria\": []}\\n'\n";
  const files: Record<string, string> = {
    "scenario.yaml": `version: 2\nslug: demo-case\ntitle: Demo case\nsummary: The service answers 502.\ntype: linux\ndifficulty: MIDDLE\ndurationMin: 20\nbrief: brief.md\ndebrief: debrief.md\nenvironment:\n${env}  break: break.sh\n  check: check.sh\n  solve: solve.sh\n`,
    "brief.md": "# Alert\n\n## Цель\n\nПочинить.\n",
    "debrief.md": "## Что было сломано\n\nПорт.\n",
    "break.sh": "#!/bin/sh\ntrue\n",
    "check.sh": grader,
    "solve.sh": "#!/bin/sh\ntrue\n",
    "image/Dockerfile": "FROM alpine:3.20\n",
    "k8s/app.yaml": "kind: Deployment\nspec:\n  containers:\n    - image: wom-scenario/demo-case:v1\n",
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
};

/** a prisma stub holding one submission; every status write is recorded */
function prismaFor(archive: Uint8Array, status: SubmissionStatus = SubmissionStatus.UPLOADED) {
  const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const row = { id: "sub1", slug: "demo-case", status, archive: Buffer.from(archive), authorId: "u1" };
  const prisma = {
    scenarioSubmission: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async () => row),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push(args);
        return { count: 1 };
      }),
      findMany: vi.fn(async () => []),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, writes, raw: prisma };
}

describe("SubmissionRunner.run", () => {
  it("checks the host before it builds anything: a full disk ends the run in FAILED with the reason, no docker build starts", async () => {
    quiet();
    const refuse = vi.fn(async () => Promise.reject(new QuotaError("Платформа временно не принимает новые сессии: заканчивается место на диске.")));
    const { prisma, writes } = prismaFor(SCENARIO("container"));
    const runner = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: host({ assertHostReady: refuse }).host });
    await runner.run("sub1");
    expect(refuse).toHaveBeenCalledWith("docker");
    expect(writes).toHaveLength(1);
    expect(writes[0].where).toEqual({ id: "sub1", status: SubmissionStatus.TESTING });
    expect(writes[0].data.status).toBe(SubmissionStatus.FAILED);
    expect(JSON.stringify(writes[0].data.testReport)).toContain("заканчивается место на диске");
  });

  it("a kubernetes scenario is checked as kubernetes (the egress guard must be alive)", async () => {
    quiet();
    const refuse = vi.fn(async () => Promise.reject(new QuotaError("защита сети не активна")));
    const { prisma } = prismaFor(SCENARIO("kubernetes"));
    const runner = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: host({ assertHostReady: refuse }).host });
    await runner.run("sub1");
    expect(refuse).toHaveBeenCalledWith("kubernetes");
  });

  it("a temp directory that cannot be created ends in FAILED, not in TESTING for good", async () => {
    quiet();
    vi.spyOn(os, "tmpdir").mockReturnValue("/nonexistent-wom-tmp/none");
    const { prisma, writes } = prismaFor(SCENARIO("container"));
    const runner = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: host().host });
    await expect(runner.run("sub1")).resolves.toBeUndefined(); // before the fix mkdtempSync threw outside the try and the row stayed TESTING
    expect(writes).toHaveLength(1);
    expect(writes[0].data.status).toBe(SubmissionStatus.FAILED);
  });

  it("the verdict is written only while the row is still TESTING: a moderator's decision made meanwhile is not overwritten", async () => {
    quiet();
    const { prisma, writes } = prismaFor(SCENARIO("container"));
    const runner = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: host({ assertHostReady: vi.fn(async () => Promise.reject(new Error("x"))) }).host });
    await runner.run("sub1");
    for (const w of writes) expect(w.where).toMatchObject({ status: SubmissionStatus.TESTING });
  });
});

describe("a test that never ends or never wrote its verdict", () => {
  it("a run past the total limit is abandoned (FAILED) and the next submission is tested", async () => {
    quiet();
    const { prisma, writes } = prismaFor(SCENARIO("container"));
    const runner = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: host().host, maxRunMs: 30 });
    const seen: string[] = [];
    (runner as unknown as { run(id: string): Promise<void> }).run = async (id: string) => {
      seen.push(id);
      if (id === "hangs") await new Promise(() => {});
    };
    runner.enqueue("hangs");
    runner.enqueue("next");
    await vi.waitFor(() => expect(seen).toEqual(["hangs", "next"]), { timeout: 3000 });
    const failed = writes.find((w) => w.where.id === "hangs");
    expect(failed?.where).toEqual({ id: "hangs", status: SubmissionStatus.TESTING });
    expect(failed?.data.status).toBe(SubmissionStatus.FAILED);
    expect(JSON.stringify(failed?.data.testReport)).toContain("лимит времени");
  });

  it("failStuck fails a TESTING row nobody owns, and leaves the one being tested and the queued ones alone", async () => {
    quiet();
    const { prisma, writes, raw } = prismaFor(SCENARIO("container"));
    raw.scenarioSubmission.findMany.mockResolvedValue([{ id: "orphan" }, { id: "running" }, { id: "queued" }] as never);
    const runner = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: host().host });
    const inner = runner as unknown as { current: string | null; queue: string[] };
    inner.current = "running";
    inner.queue.push("queued");
    expect(await runner.failStuck(60_000, new Date("2026-10-03T12:00:00Z"))).toEqual(["orphan"]);
    expect(writes.map((w) => w.where.id)).toEqual(["orphan"]);
    expect(writes[0].where).toEqual({ id: "orphan", status: SubmissionStatus.TESTING });
    // the query only looks at rows that have not moved for the grace period
    const q = raw.scenarioSubmission.findMany.mock.calls[0] as unknown as [{ where: { status: string; updatedAt: { lt: Date } } }];
    expect(q[0].where.status).toBe(SubmissionStatus.TESTING);
    expect(q[0].where.updatedAt.lt).toEqual(new Date("2026-10-03T11:59:00Z"));
  });
});
