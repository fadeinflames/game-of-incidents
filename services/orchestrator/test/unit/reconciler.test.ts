// Reconciler passes against stubs: no database, no Docker.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatus, type PrismaClient } from "@wom/db";
import { FakeRuntimeProvider, RuntimeRegistry, type ListedSandbox, type RuntimeProvider, type SandboxHandle } from "@wom/runtime";
import { logger } from "../../src/logger";
import { Reconciler, type ReconcilerOptions } from "../../src/reconciler";
import type { SessionService } from "../../src/sessions";

type Row = { id: string; status: SessionStatus; runtimeHandle: SandboxHandle | null; readyAt: Date | null };

const OPTS: ReconcilerOptions = { provisioningTimeoutMs: 60_000, intervalMs: 60_000 };
const dockerHandle = (n: string): SandboxHandle => ({ provider: "docker", containerId: `c-${n}`, networkId: `n-${n}` });
const sandbox = (n: string, sessionId: string | null): ListedSandbox => ({ handle: dockerHandle(n), sessionId, createdAt: new Date(Date.now() - 60_000), labels: {} });

function prismaWith(active: () => Row[], over: { expired?: string[]; stuck?: string[] } = {}) {
  const findMany = vi.fn(async (args: { where: { OR?: unknown; expiresAt?: unknown } }) => {
    if (args.where.OR) return (over.stuck ?? []).map((id) => ({ id }));
    if (args.where.expiresAt) return (over.expired ?? []).map((id) => ({ id }));
    return active();
  });
  return { prisma: { trainingSession: { findMany } } as unknown as PrismaClient, findMany };
}

function sessionsStub(over: Record<string, unknown> = {}) {
  return {
    releaseStaleK8sSlots: async () => 0,
    releaseStuckChecks: async () => 0,
    kill: vi.fn(async () => {}),
    isDestroying: vi.fn(() => false),
    ...over,
  };
}

const quiet = () => [vi.spyOn(logger, "warn").mockImplementation(() => {}), vi.spyOn(logger, "error").mockImplementation(() => {}), vi.spyOn(logger, "info").mockImplementation(() => {})] as const;

afterEach(() => vi.restoreAllMocks());

/** counts how many of the calls made through `wrap` overlap */
function overlap() {
  let now = 0;
  let peak = 0;
  return {
    peak: () => peak,
    wrap: async <T>(work: () => T | Promise<T>): Promise<T> => {
      now++;
      peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return work();
    },
  };
}

describe("order of the runtime list and the active sessions", () => {
  // A stand is created and attached to its row right after the first of the two reads. Read in the old order
  // (sessions, then list) the new container is in the list but its session is not in the snapshot: destroyed as an orphan.
  function race() {
    const rows: Row[] = [];
    const containers: ListedSandbox[] = [];
    let created = false;
    const createStand = () => {
      if (created) return;
      created = true;
      rows.push({ id: "fresh", status: SessionStatus.RUNNING, runtimeHandle: dockerHandle("fresh"), readyAt: new Date(Date.now() + 5) });
      containers.push(sandbox("fresh", "fresh"));
    };
    // whichever read comes first does not see the stand, the one after it does
    const { prisma } = prismaWith(() => {
      const snapshot = [...rows];
      createStand();
      return snapshot;
    });
    const destroy = vi.fn(async () => {});
    const runtime = {
      list: async () => {
        const snapshot = [...containers];
        createStand();
        return snapshot;
      },
      destroy,
      status: async () => "running" as const,
    } as unknown as RuntimeProvider;
    const sessions = sessionsStub();
    return { rec: new Reconciler(prisma, runtime, sessions as unknown as SessionService, OPTS), destroy, sessions };
  }

  it("a stand created between the two reads is neither destroyed as an orphan nor killed as vanished", async () => {
    quiet();
    const { rec, destroy, sessions } = race();
    expect(await rec.run()).toMatchObject({ orphans: 0, vanished: 0 });
    expect(destroy).not.toHaveBeenCalled();
    expect(sessions.kill).not.toHaveBeenCalled();
  });

  it("a session older than the listing whose sandbox is not listed is still killed as vanished", async () => {
    quiet();
    const { prisma } = prismaWith(() => [{ id: "old", status: SessionStatus.RUNNING, runtimeHandle: dockerHandle("old"), readyAt: new Date(Date.now() - 60_000) }]);
    const sessions = sessionsStub();
    const rec = new Reconciler(prisma, { list: async () => [], destroy: vi.fn(), status: vi.fn() } as unknown as RuntimeProvider, sessions as unknown as SessionService, OPTS);
    expect(await rec.run()).toMatchObject({ vanished: 1 });
    expect(sessions.kill).toHaveBeenCalledWith("old", "sandbox disappeared", SessionStatus.KILLED);
  });
});

describe("orphans", () => {
  it("are destroyed a few at a time, and every one is logged with its session and age", async () => {
    const [warn] = quiet();
    const gauge = overlap();
    const orphans = Array.from({ length: 10 }, (_, i) => sandbox(String(i), `gone-${i}`));
    const destroy = vi.fn((h: SandboxHandle) => gauge.wrap(() => h));
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, { list: async () => orphans, destroy } as unknown as RuntimeProvider, sessionsStub() as unknown as SessionService, OPTS);
    expect(await rec.run()).toMatchObject({ orphans: 10 });
    expect(destroy).toHaveBeenCalledTimes(10);
    expect(gauge.peak()).toBeGreaterThan(1); // one by one took 10 destroys in a row
    expect(gauge.peak()).toBeLessThanOrEqual(4);
    const logged = warn.mock.calls.filter((c) => c[1] === "orphan sandbox: destroying");
    expect(logged).toHaveLength(10);
    expect(logged[0][0]).toMatchObject({ sessionId: "gone-0", attempt: 1, containerId: "c-0", why: "its session is not active" });
    expect(logged[0][0]).toHaveProperty("ageSec");
  });

  it("one that keeps surviving is reported as an error from the third attempt on, and is not counted as destroyed", async () => {
    const [warn, error] = quiet();
    const destroy = vi.fn(async () => {
      throw new Error("container is marked for removal");
    });
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, { list: async () => [sandbox("stuck", "gone")], destroy } as unknown as RuntimeProvider, sessionsStub() as unknown as SessionService, OPTS);
    for (let pass = 1; pass <= 3; pass++) {
      expect(await rec.run()).toMatchObject({ orphans: 0 });
      expect(error.mock.calls.filter((c) => c[1] === "orphan sandbox survived several destroy attempts")).toHaveLength(pass === 3 ? 1 : 0);
    }
    expect(warn.mock.calls.filter((c) => c[1] === "orphan destroy failed")).toHaveLength(3);
    expect(destroy).toHaveBeenCalledTimes(3);
  });

  it("the attempt counter starts over for an orphan that was gone for a pass", async () => {
    const [, error] = quiet();
    let listed = [sandbox("flaky", "gone")];
    const destroy = vi.fn(async () => {
      throw new Error("busy");
    });
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, { list: async () => listed, destroy } as unknown as RuntimeProvider, sessionsStub() as unknown as SessionService, OPTS);
    await rec.run();
    await rec.run();
    listed = [];
    await rec.run();
    listed = [sandbox("flaky", "gone")];
    await rec.run();
    expect(error.mock.calls.filter((c) => c[1] === "orphan sandbox survived several destroy attempts")).toHaveLength(0);
  });

  it("a sandbox the orchestrator is already destroying is left alone", async () => {
    quiet();
    const destroy = vi.fn(async () => {});
    const { prisma } = prismaWith(() => []);
    const sessions = sessionsStub({ isDestroying: vi.fn((h: SandboxHandle) => h.containerId === "c-leaving") });
    const rec = new Reconciler(prisma, { list: async () => [sandbox("leaving", "just-killed"), sandbox("lost", "gone")], destroy } as unknown as RuntimeProvider, sessions as unknown as SessionService, OPTS);
    expect(await rec.run()).toMatchObject({ orphans: 1 });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ containerId: "c-lost" }));
  });

  it("a pass that used up its time budget leaves the rest for the next one and still finishes", async () => {
    const [warn] = quiet();
    const destroy = vi.fn(async () => {});
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, { list: async () => [sandbox("a", null), sandbox("b", null)], destroy } as unknown as RuntimeProvider, sessionsStub() as unknown as SessionService, {
      ...OPTS,
      orphanBudgetMs: -1,
    });
    expect(await rec.run()).toMatchObject({ orphans: 0 });
    expect(destroy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ left: 2 }, expect.stringContaining("time budget"));
    expect(rec.lastRunAt).not.toBeNull();
  });
});

describe("stopping sessions", () => {
  it("expired and stuck sessions are stopped a few at a time, not one after another", async () => {
    quiet();
    const gauge = overlap();
    const ids = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const sessions = sessionsStub({ kill: vi.fn((id: string) => gauge.wrap(() => undefined)) });
    const { prisma } = prismaWith(() => [], { expired: ids.slice(0, 6), stuck: ids.slice(6) });
    const rec = new Reconciler(prisma, { list: async () => [] } as unknown as RuntimeProvider, sessions as unknown as SessionService, OPTS);
    expect(await rec.run()).toMatchObject({ expired: 6, stuck: 3 });
    expect(sessions.kill).toHaveBeenCalledTimes(9);
    expect(gauge.peak()).toBeGreaterThan(1);
    expect(gauge.peak()).toBeLessThanOrEqual(4);
  });
});

describe("kubernetes that does not answer", () => {
  const k8sHandle: SandboxHandle = { provider: "kubernetes", containerId: "tools-1", networkId: "wom-k8s-a", clusterName: "wom-k8s-a", ownsNetwork: true };
  const k8sRow: Row = { id: "k8s-session", status: SessionStatus.RUNNING, runtimeHandle: k8sHandle, readyAt: new Date(Date.now() - 600_000) };

  function registry(ping: () => Promise<void>) {
    const kubernetes = Object.assign(new FakeRuntimeProvider(), { ping: vi.fn(ping) });
    return { kubernetes, runtime: new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes }) };
  }

  it("does not kill kubernetes sessions because their cluster is missing from a list that never asked kind", async () => {
    const [, error] = quiet();
    const { runtime } = registry(async () => Promise.reject(new Error("kind: not found")));
    await runtime.probeKubernetes(); // startup: kind does not answer
    const { prisma } = prismaWith(() => [k8sRow]);
    const sessions = sessionsStub();
    const rec = new Reconciler(prisma, runtime, sessions as unknown as SessionService, OPTS);
    expect(await rec.run()).toMatchObject({ vanished: 0 });
    expect(sessions.kill).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith({}, expect.stringContaining("kubernetes runtime is not available"));
  });

  it("probes again on the next pass, and judges the sessions once kind is back", async () => {
    const [, , info] = quiet();
    let up = false;
    const { runtime, kubernetes } = registry(async () => {
      if (!up) throw new Error("kind: not found");
    });
    await runtime.probeKubernetes();
    const { prisma } = prismaWith(() => [k8sRow]);
    const sessions = sessionsStub();
    const rec = new Reconciler(prisma, runtime, sessions as unknown as SessionService, OPTS);
    await rec.run();
    expect(sessions.kill).not.toHaveBeenCalled();
    up = true;
    // kind answers again, but the cluster really is gone from the (now complete) list: the session is dead
    expect(await rec.run()).toMatchObject({ vanished: 1 });
    expect(kubernetes.ping).toHaveBeenCalledTimes(3);
    expect(sessions.kill).toHaveBeenCalledWith("k8s-session", "sandbox disappeared", SessionStatus.KILLED);
    expect(info).toHaveBeenCalledWith({}, "kubernetes runtime is available again");
  });

  it("docker sessions are checked as usual meanwhile", async () => {
    quiet();
    const { runtime } = registry(async () => Promise.reject(new Error("down")));
    await runtime.probeKubernetes();
    const gone: Row = { id: "docker-session", status: SessionStatus.RUNNING, runtimeHandle: dockerHandle("gone"), readyAt: new Date(Date.now() - 600_000) };
    const { prisma } = prismaWith(() => [k8sRow, gone]);
    const sessions = sessionsStub();
    const rec = new Reconciler(prisma, runtime, sessions as unknown as SessionService, OPTS);
    expect(await rec.run()).toMatchObject({ vanished: 1 });
    expect(sessions.kill).toHaveBeenCalledTimes(1);
    expect(sessions.kill).toHaveBeenCalledWith("docker-session", "sandbox disappeared", SessionStatus.KILLED);
  });
});

describe("orphan networks", () => {
  const runtimeWithNetworks = (removeOrphanNetworks: (minAge: number) => Promise<number>) => ({ list: async () => [], removeOrphanNetworks }) as unknown as RuntimeProvider;

  it("are swept with an age that spares a cluster still being created, and not on every pass", async () => {
    quiet();
    const sweep = vi.fn(async (_minAge: number) => 0);
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, runtimeWithNetworks(sweep), sessionsStub() as unknown as SessionService, { ...OPTS, provisioningTimeoutMs: 300_000 });
    await rec.run();
    await rec.run();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(600_000); // twice the provisioning timeout
  });

  it("a failed sweep is logged and does not fail the pass", async () => {
    const [warn] = quiet();
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, runtimeWithNetworks(async () => Promise.reject(new Error("daemon busy"))), sessionsStub() as unknown as SessionService, { ...OPTS, networkSweepEveryMs: 0 });
    await expect(rec.run()).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith({ err: "daemon busy" }, "orphan network sweep failed");
    expect(rec.lastRunAt).not.toBeNull();
  });

  it("the sweep is reported when it removed something", async () => {
    const [warn] = quiet();
    const { prisma } = prismaWith(() => []);
    const rec = new Reconciler(prisma, runtimeWithNetworks(async () => 3), sessionsStub() as unknown as SessionService, OPTS);
    await rec.run();
    expect(warn).toHaveBeenCalledWith({ removed: 3 }, "orphan sandbox networks removed");
  });
});
