// A session runs on the scenario as it was when it was requested (types-6), and the ownership check of a session (tests-4).
// Stubbed database, fake runtime: no PostgreSQL, no Docker.
import { describe, expect, it, vi } from "vitest";
import { SessionStatus, type PrismaClient } from "@wom/db";
import { FakeRuntimeProvider, type SandboxHandle } from "@wom/runtime";
import { logger } from "../../src/logger";
import { pinnedEnvironment, pinnedScenario, readHints, snapshotScenario } from "../../src/scenario-snapshot";
import { SessionService, StateError } from "../../src/sessions";

const PASS = '{"passed":true,"criteria":[{"id":"x","ok":true,"message":"ok"}]}';
const HANDLE: SandboxHandle = { provider: "docker", containerId: "c1", networkId: "n1" };

/** the scenario row as the first import left it, and as a later import rewrote it */
const OLD = {
  environmentJson: { image: "wom-scenario/x:1", shell: { user: "oncall", cwd: "/home/oncall", shell: "/bin/bash" } },
  hintsJson: [
    { level: 1, text: "old hint", penalty: 10 },
    { level: 2, text: "old second", penalty: 20 },
  ],
  breakScript: "echo old-break",
  graderScript: "echo old-check",
};
const NEW = {
  environmentJson: { image: "wom-scenario/x:2", shell: { user: "root", cwd: "/", shell: "/bin/sh" } },
  hintsJson: [{ level: 1, text: "new hint", penalty: 0 }],
  breakScript: "echo new-break",
  graderScript: "echo new-check",
};

const options = { maxSessionsPerUser: 1, maxSessionsGlobal: 10, breakTimeoutMs: 1000, graderTimeoutMs: 1000, defaultTtlMin: 45 };

function sessionRow(over: Record<string, unknown> = {}) {
  return { id: "s1", userId: "u1", scenarioId: "sc", status: SessionStatus.RUNNING, runtimeHandle: HANDLE, hintsUsed: [], checkAttempts: 0, scenarioSnapshot: snapshotScenario(OLD as never), ...over };
}

/** a database holding one session row and the live scenario; `writes` collects every update of the session */
function setup(over: { session?: Record<string, unknown> | null; live?: typeof NEW | null } = {}) {
  const runtime = new FakeRuntimeProvider();
  const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const session = over.session === undefined ? sessionRow() : over.session;
  const live = over.live === undefined ? NEW : over.live;
  const prisma = {
    trainingSession: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push(args);
        return { count: 1 };
      }),
    },
    scenario: { findUnique: vi.fn(async () => live) },
    sessionEvent: { create: vi.fn(async () => ({})) },
  };
  const svc = new SessionService(prisma as unknown as PrismaClient, runtime, options);
  return { svc, runtime, prisma, writes };
}

describe("snapshotScenario / pinnedScenario", () => {
  it("keeps what the session needs and reads it back", () => {
    const snap = snapshotScenario(OLD as never);
    const pinned = pinnedScenario({ scenarioSnapshot: snap }, NEW as never);
    expect(pinned).toMatchObject({ pinned: true, graderScript: "echo old-check", breakScript: "echo old-break" });
    expect(pinned.hints).toEqual([
      { level: 1, text: "old hint", penalty: 10 },
      { level: 2, text: "old second", penalty: 20 },
    ]);
    expect(pinnedEnvironment(pinned)).toMatchObject({ image: "wom-scenario/x:1" });
  });

  it("a session without a snapshot (created before the column existed) runs on the live scenario", () => {
    for (const none of [null, undefined, {}, { v: 2 }, "text", { v: 1, hints: "no" }]) {
      const pinned = pinnedScenario({ scenarioSnapshot: none }, NEW as never);
      expect(pinned.pinned).toBe(false);
      expect(pinned.graderScript).toBe("echo new-check");
    }
  });

  it("no snapshot and no scenario is an empty scenario, not a crash", () => {
    expect(pinnedScenario({ scenarioSnapshot: null }, null)).toEqual({ environmentJson: null, hints: [], breakScript: null, graderScript: null, pinned: false });
  });

  it("hints keep only entries that are hints, and a missing penalty is 0", () => {
    expect(readHints([{ level: 1, text: "a" }, { level: "2", text: "b" }, null, [], { level: 3 }, { level: 4, text: "d", penalty: "x" }])).toEqual([
      { level: 1, text: "a", penalty: 0 },
      { level: 4, text: "d", penalty: 0 },
    ]);
    expect(readHints({ not: "an array" })).toEqual([]);
  });

  it("an environment of the wrong shape is refused, a text-only scenario has none", () => {
    expect(pinnedEnvironment({ environmentJson: null })).toBeNull();
    expect(() => pinnedEnvironment({ environmentJson: "docker" })).toThrow(/object/);
    expect(() => pinnedEnvironment({ environmentJson: { kind: "vm", image: "x" } })).toThrow(/kind/);
    expect(() => pinnedEnvironment({ environmentJson: { kind: "kubernetes" } })).toThrow(/image/);
  });
});

describe("a running session is not changed by a re-import of its scenario", () => {
  it("check() grades with the grader the session started with", async () => {
    const { svc, runtime } = setup();
    runtime.sandboxes.set(HANDLE.containerId, { spec: {} as never, status: "running", createdAt: new Date() });
    runtime.scriptResponder = () => ({ exitCode: 0, stdout: PASS, stderr: "", timedOut: false });
    await svc.check("s1");
    expect(runtime.scripts).toEqual(["echo old-check"]); // the live scenario says "echo new-check"
  });

  it("the score uses the penalties of the hints as they were", async () => {
    const { svc, runtime, writes } = setup({ session: sessionRow({ hintsUsed: [1, 2] }) });
    runtime.sandboxes.set(HANDLE.containerId, { spec: {} as never, status: "running", createdAt: new Date() });
    runtime.scriptResponder = () => ({ exitCode: 0, stdout: PASS, stderr: "", timedOut: false });
    await svc.check("s1");
    const finish = writes.find((w) => w.data.status === SessionStatus.FINISHED);
    expect(finish?.data.score).toBe(70); // 100 - 10 - 20; the live scenario has one free hint
  });

  it("a hint is the text the session was given, and a hint the old scenario did not have is not there", async () => {
    const { svc } = setup();
    await expect(svc.useHint("s1", 1)).resolves.toEqual({ text: "old hint", penalty: 10 });
    const second = setup({ live: { ...NEW, hintsJson: [...NEW.hintsJson, { level: 3, text: "added later", penalty: 0 }] } });
    await expect(second.svc.useHint("s1", 3)).rejects.toMatchObject({ code: "no-such-hint" });
  });

  it("the terminal opens the shell of the pinned environment", async () => {
    const { svc } = setup();
    expect(await svc.terminalTarget("s1")).toMatchObject({ user: "oncall", shell: "/bin/bash", cwd: "/home/oncall", handle: HANDLE });
  });

  it("a session from before the snapshot existed still works on the live scenario", async () => {
    const { svc, runtime } = setup({ session: sessionRow({ scenarioSnapshot: null }) });
    runtime.sandboxes.set(HANDLE.containerId, { spec: {} as never, status: "running", createdAt: new Date() });
    await svc.check("s1");
    expect(runtime.scripts).toEqual(["echo new-check"]);
    expect(await svc.terminalTarget("s1")).toMatchObject({ user: "root", shell: "/bin/sh" });
  });
});

describe("create() copies the scenario into the session", () => {
  function creating(environmentJson: unknown) {
    const created: { data: Record<string, unknown> }[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      trainingSession: {
        count: vi.fn(async () => 0),
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return { id: "new1", ...args.data };
        }),
      },
    };
    const prisma = {
      scenario: { findUnique: vi.fn(async () => ({ id: "sc", isPublished: true, ...NEW, environmentJson })) },
      // provisioning starts in the background; with the claim lost it returns at once
      trainingSession: { updateMany: vi.fn(async () => ({ count: 0 })) },
      sessionEvent: { create: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const svc = new SessionService(prisma as unknown as PrismaClient, new FakeRuntimeProvider(), options);
    return { svc, created, tx };
  }

  it("stores the environment, hints and scripts of the moment", async () => {
    const { svc, created } = creating(NEW.environmentJson);
    await svc.create("u1", "sc");
    expect(created).toHaveLength(1);
    expect(created[0].data.scenarioSnapshot).toEqual({ v: 1, environment: NEW.environmentJson, hints: [{ level: 1, text: "new hint", penalty: 0 }], breakScript: "echo new-break", graderScript: "echo new-check" });
  });

  it("refuses a scenario whose stored environment is not an environment, before any row is written", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { svc, created, tx } = creating({ kind: "kubernetes" });
    await expect(svc.create("u1", "sc")).rejects.toBeInstanceOf(StateError);
    expect(tx.trainingSession.create).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("getOwned", () => {
  it("gives a session to its owner and to nobody else", async () => {
    const { svc } = setup();
    expect(await svc.getOwned("s1", "u1")).toMatchObject({ id: "s1" });
    expect(await svc.getOwned("s1", "u2")).toBeNull();
    expect(await svc.getOwned("s1", "")).toBeNull();
  });

  it("a session that does not exist is null, not an error", async () => {
    const { svc } = setup({ session: null });
    expect(await svc.getOwned("nope", "u1")).toBeNull();
  });
});

describe("recoverAfterRestart", () => {
  function restarting(queued: Record<string, unknown>[]) {
    const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    const prisma = {
      trainingSession: {
        findMany: vi.fn(async (args: { where: { status: SessionStatus } }) => (args.where.status === SessionStatus.REQUESTED ? queued : [])),
        findUnique: vi.fn(async () => ({ id: "q1", runtimeHandle: null })),
        updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 0 }; // the claim of provisioning is lost at once; a kill is the only write that matters here
        }),
      },
      sessionEvent: { create: vi.fn(async () => ({})) },
    };
    return { svc: new SessionService(prisma as unknown as PrismaClient, new FakeRuntimeProvider(), options), updates };
  }

  it("fails a queued session whose scenario has no stand any more, instead of leaving it in the queue", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { svc, updates } = restarting([{ id: "q1", scenarioSnapshot: null, scenario: { ...NEW, environmentJson: null } }]);
    await svc.recoverAfterRestart();
    await vi.waitFor(() => expect(updates.some((u) => u.data.status === SessionStatus.FAILED)).toBe(true));
    vi.restoreAllMocks();
  });
});
