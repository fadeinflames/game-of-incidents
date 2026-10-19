// Background destroy and best-effort events: pure logic, a stubbed database and a fake runtime that can be made slow or broken.
import { describe, expect, it, vi } from "vitest";
import { Prisma, SessionStatus, type PrismaClient } from "@wom/db";
import { FakeRuntimeProvider, type SandboxHandle } from "@wom/runtime";
import { logger } from "../../src/logger";
import { SessionService } from "../../src/sessions";

class SlowRuntime extends FakeRuntimeProvider {
  destroyCalls: SandboxHandle[] = [];
  private gate: Promise<void> = Promise.resolve();
  failDestroy: Error | null = null;
  hold() {
    let open!: () => void;
    this.gate = new Promise<void>((resolve) => (open = resolve));
    return open;
  }
  async destroy(h: SandboxHandle) {
    this.destroyCalls.push(h);
    await this.gate;
    if (this.failDestroy) throw this.failDestroy;
    await super.destroy(h);
  }
}

const HANDLE: SandboxHandle = { provider: "docker", containerId: "c1", networkId: "n1" };

function setup(over: { eventFails?: boolean; handle?: SandboxHandle | null } = {}) {
  const runtime = new SlowRuntime();
  const create = vi.fn(async () => {
    if (over.eventFails) throw new Error("database is gone");
    return {};
  });
  const prisma = {
    trainingSession: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ id: "s1", status: SessionStatus.RUNNING, runtimeHandle: over.handle === undefined ? HANDLE : over.handle, hintsUsed: [], scenarioId: "sc" })),
    },
    scenario: { findUnique: vi.fn(async () => ({ hintsJson: [{ level: 1, text: "look at the logs", penalty: 5 }] })) },
    sessionEvent: { create },
  };
  const svc = new SessionService(prisma as unknown as PrismaClient, runtime, { maxSessionsPerUser: 1, maxSessionsGlobal: 10, breakTimeoutMs: 1000, graderTimeoutMs: 1000, defaultTtlMin: 45 });
  return { svc, runtime, prisma, create };
}

describe("kill: the sandbox goes in the background", () => {
  it("returns while the destroy is still running, and the destroy does run", async () => {
    const { svc, runtime } = setup();
    const open = runtime.hold();
    let finished = false;
    await svc.kill("s1", "killed by user").then(() => (finished = true));
    expect(finished).toBe(true); // before the fix this awaited a destroy that takes two minutes for a cluster
    expect(runtime.destroyCalls).toEqual([HANDLE]);
    expect(svc.isDestroying(HANDLE)).toBe(true);
    open();
    await svc.settleDestroys(1000);
    expect(svc.isDestroying(HANDLE)).toBe(false);
  });

  it("a destroy that fails is counted and logged, never thrown at the caller", async () => {
    const { svc, runtime } = setup();
    runtime.failDestroy = new Error("kind delete timed out");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await expect(svc.kill("s1", "ttl expired", SessionStatus.EXPIRED)).resolves.toBeUndefined();
    await svc.settleDestroys(1000);
    expect(svc.destroyFailures).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", failures: 1 }), expect.stringContaining("destroy failed"));
    expect(svc.isDestroying(HANDLE)).toBe(false); // free for the reconciler to retry
    warn.mockRestore();
  });

  it("a sandbox is destroyed once even when two callers stop the same session", async () => {
    const { svc, runtime } = setup();
    const open = runtime.hold();
    await Promise.all([svc.kill("s1", "a"), svc.kill("s1", "b")]);
    open();
    await svc.settleDestroys(1000);
    expect(runtime.destroyCalls).toHaveLength(1);
  });

  it("at most four sandboxes are destroyed at the same time (a disk-pressure kill stops everything at once)", async () => {
    const { svc, runtime } = setup();
    const open = runtime.hold();
    const handles = Array.from({ length: 7 }, (_, i): SandboxHandle => ({ provider: "docker", containerId: `c${i}`, networkId: `n${i}` }));
    for (const [i, h] of handles.entries()) {
      (svc as unknown as { destroyInBackground(id: string, h: SandboxHandle, why: string): void }).destroyInBackground(`s${i}`, h, "test");
    }
    expect(runtime.destroyCalls).toHaveLength(4);
    open();
    await svc.settleDestroys(1000);
    expect(runtime.destroyCalls).toHaveLength(7);
  });

  it("settleDestroys gives up after its timeout instead of waiting for a hung destroy", async () => {
    const { svc, runtime } = setup();
    runtime.hold();
    await svc.kill("s1", "x");
    const t0 = Date.now();
    await svc.settleDestroys(30);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(svc.isDestroying(HANDLE)).toBe(true);
  });
});

describe("the runtime handle (for a cluster: its admin kubeconfig) does not outlive the sandbox", () => {
  const handleWrites = (prisma: ReturnType<typeof setup>["prisma"]) =>
    prisma.trainingSession.updateMany.mock.calls
      .map((c) => (c as unknown[])[0] as { where: { id: string; status: { notIn: SessionStatus[] } }; data: { runtimeHandle?: unknown } })
      .filter((c) => "runtimeHandle" in c.data);

  it("is cleared once the destroy succeeded, and only on a row that is no longer active", async () => {
    const { svc, prisma } = setup();
    await svc.kill("s1", "killed by user");
    await svc.settleDestroys(1000);
    const writes = handleWrites(prisma);
    expect(writes).toHaveLength(1);
    expect(writes[0].where.id).toBe("s1");
    expect(writes[0].where.status.notIn).toContain(SessionStatus.RUNNING);
    expect(writes[0].where.status.notIn).toContain(SessionStatus.PROVISIONING);
    expect(writes[0].data.runtimeHandle).toBe(Prisma.DbNull);
  });

  it("stays when the destroy failed: the row is what tells the operator which cluster is left", async () => {
    const { svc, runtime, prisma } = setup();
    runtime.failDestroy = new Error("kind delete timed out");
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    await svc.kill("s1", "ttl expired", SessionStatus.EXPIRED);
    await svc.settleDestroys(1000);
    expect(handleWrites(prisma)).toHaveLength(0);
  });

  it("a failed clean-up of the handle is logged and does not reject anything", async () => {
    const { svc, prisma } = setup();
    prisma.trainingSession.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("connection reset"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await svc.kill("s1", "killed by user");
    await svc.settleDestroys(1000);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "runtime handle not cleared");
  });
});

describe("check: the verdict does not wait for the sandbox to go", () => {
  it("a passed check returns while the destroy is still running", async () => {
    const { svc, runtime, prisma } = setup();
    const sandbox = await runtime.create({ image: "x", writable: [], tmpfs: {}, capAdd: [], sudo: false, resources: { cpus: 1, memoryMb: 1, pids: 1 }, labels: {} });
    prisma.trainingSession.findUnique.mockResolvedValue({ id: "s1", status: SessionStatus.CHECKING, runtimeHandle: sandbox, hintsUsed: [], scenarioId: "sc" } as never);
    prisma.scenario.findUnique.mockResolvedValue({ graderScript: "check", hintsJson: [] } as never);
    runtime.scriptResponder = () => ({ exitCode: 0, stdout: '{"passed":true,"criteria":[{"id":"x","ok":true,"message":"ok"}]}', stderr: "", timedOut: false });
    const open = runtime.hold();
    const r = await svc.check("s1");
    expect(r.result).toMatchObject({ status: "ok", passed: true });
    expect(runtime.destroyCalls).toEqual([sandbox]);
    expect(svc.isDestroying(sandbox)).toBe(true);
    open();
    await svc.settleDestroys(1000);
  });
});

describe("a session event that cannot be written", () => {
  it("does not stop kill: the sandbox is still destroyed and the failure is logged", async () => {
    const { svc, runtime, create } = setup({ eventFails: true });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await expect(svc.kill("s1", "killed by user")).resolves.toBeUndefined();
    await svc.settleDestroys(1000);
    expect(create).toHaveBeenCalled();
    expect(runtime.destroyCalls).toEqual([HANDLE]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", kind: "status" }), "session event not recorded");
    warn.mockRestore();
  });

  it("does not turn an opened hint into an error for the player", async () => {
    const { svc, prisma } = setup({ eventFails: true });
    prisma.scenario.findUnique.mockResolvedValue({ hintsJson: [{ level: 1, text: "look at the logs", penalty: 5 }] } as never);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await expect(svc.useHint("s1", 1)).resolves.toEqual({ text: "look at the logs", penalty: 5 });
    warn.mockRestore();
  });
});

describe("provisioning failure and the cluster slot", () => {
  it("the slot is released while the half-built cluster is still being destroyed", async () => {
    const runtime = new SlowRuntime();
    const claimed = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      trainingSession: { updateMany: claimed, update: vi.fn(async () => ({})) },
      sessionEvent: { create: vi.fn(async () => ({})) },
    };
    const svc = new SessionService(prisma as unknown as PrismaClient, runtime, { maxSessionsPerUser: 1, maxSessionsGlobal: 10, maxK8sProvisioning: 1, breakTimeoutMs: 1000, graderTimeoutMs: 1000, defaultTtlMin: 45 });
    runtime.scriptResponder = () => ({ exitCode: 1, stdout: "", stderr: "break failed", timedOut: false });
    const open = runtime.hold();
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const scenario = { environmentJson: { kind: "kubernetes", image: "wom-tools:dev" }, breakScript: "boom" };
    await (svc as unknown as { provision(id: string, s: unknown): Promise<void> }).provision("s1", scenario);
    // provision() returned, so the slot is free for the next session, while the destroy has not finished
    expect((svc as unknown as { k8sHolders: Set<string> }).k8sHolders.size).toBe(0);
    expect(runtime.destroyCalls).toHaveLength(1);
    open();
    await svc.settleDestroys(1000);
    error.mockRestore();
  });
});
