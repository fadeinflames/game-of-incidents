// Provisioning slots, queue positions and the player's view of a session: pure logic, a stubbed database.
import { describe, expect, it, vi } from "vitest";
import { SessionStatus, type PrismaClient, type TrainingSession } from "@wom/db";
import { FakeRuntimeProvider } from "@wom/runtime";
import { PROVISIONING_TIMEOUT_REASON, RESTART_MESSAGE, SessionService, toPlayerView } from "../../src/sessions";

type Internals = {
  k8sHolders: Set<string>;
  k8sWaiters: unknown[];
  acquireK8sSlot(id: string): Promise<boolean>;
  releaseK8sSlot(id: string): void;
  cancelK8sWaiter(id: string): void;
  provision(id: string, scenario: unknown): Promise<void>;
};

function service(prisma: Record<string, unknown>, maxK8sProvisioning = 2) {
  const svc = new SessionService(prisma as unknown as PrismaClient, new FakeRuntimeProvider(), {
    maxSessionsPerUser: 1,
    maxSessionsGlobal: 10,
    maxK8sProvisioning,
    breakTimeoutMs: 1000,
    graderTimeoutMs: 1000,
    defaultTtlMin: 45,
  });
  return { svc, inner: svc as unknown as Internals };
}

const quietDb = () => ({
  trainingSession: {
    updateMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => []),
  },
});

describe("kubernetes provisioning slots", () => {
  it("hands a freed slot to the first waiter, in order, and never to a newcomer in between", async () => {
    const { svc, inner } = service(quietDb(), 1);
    expect(await inner.acquireK8sSlot("a")).toBe(true);
    const order: string[] = [];
    const b = inner.acquireK8sSlot("b").then((ok) => order.push(`b:${ok}`));
    const c = inner.acquireK8sSlot("c").then((ok) => order.push(`c:${ok}`));
    expect(svc.queuePosition("b")).toBe(1);
    expect(svc.queuePosition("c")).toBe(2);
    expect(svc.queuePosition("a")).toBeNull();
    inner.releaseK8sSlot("a");
    // a newcomer arriving right after the release finds the slot taken by "b" and queues behind "c"
    const d = inner.acquireK8sSlot("d");
    await b;
    expect([...inner.k8sHolders]).toEqual(["b"]);
    expect(svc.queuePosition("c")).toBe(1);
    expect(svc.queuePosition("d")).toBe(2);
    inner.releaseK8sSlot("b");
    await c;
    inner.releaseK8sSlot("c");
    expect(await d).toBe(true);
    expect(order).toEqual(["b:true", "c:true"]);
  });

  it("a session stopped in the queue leaves it at once and its place goes to the next one", async () => {
    const { svc, inner } = service(quietDb(), 1);
    await inner.acquireK8sSlot("a");
    const b = inner.acquireK8sSlot("b");
    const c = inner.acquireK8sSlot("c");
    inner.cancelK8sWaiter("b");
    expect(await b).toBe(false);
    expect(svc.queuePosition("c")).toBe(1);
    inner.releaseK8sSlot("a");
    expect(await c).toBe(true);
  });

  it("releasing a slot that is not held changes nothing", async () => {
    const { inner } = service(quietDb(), 1);
    await inner.acquireK8sSlot("a");
    const b = inner.acquireK8sSlot("b");
    inner.releaseK8sSlot("zzz");
    expect([...inner.k8sHolders]).toEqual(["a"]);
    inner.releaseK8sSlot("a");
    inner.releaseK8sSlot("a"); // a second release must not wake a waiter that is not next
    expect(await b).toBe(true);
    expect([...inner.k8sHolders]).toEqual(["b"]);
  });

  it("a database error during provisioning does not leak the slot", async () => {
    const prisma = quietDb();
    prisma.trainingSession.updateMany.mockRejectedValue(new Error("connection reset"));
    const { svc, inner } = service(prisma, 1);
    const scenario = { environmentJson: { kind: "kubernetes", image: "wom-tools:dev" } };
    await expect(inner.provision("s1", scenario)).rejects.toThrow("connection reset");
    expect(inner.k8sHolders.size).toBe(0);
    // the next session gets the slot straight away
    expect(await inner.acquireK8sSlot("s2")).toBe(true);
    expect(svc.queuePosition("s2")).toBeNull();
  });

  it("the reconciler sweep gives back the slots of sessions that are no longer provisioning", async () => {
    const prisma = quietDb();
    const { svc, inner } = service(prisma, 2);
    await inner.acquireK8sSlot("alive");
    await inner.acquireK8sSlot("dead");
    const waiting = inner.acquireK8sSlot("next");
    prisma.trainingSession.findMany.mockResolvedValue([{ id: "alive" }] as never);
    expect(await svc.releaseStaleK8sSlots()).toBe(1);
    expect(await waiting).toBe(true);
    expect([...inner.k8sHolders].sort()).toEqual(["alive", "next"]);
    expect(await svc.releaseStaleK8sSlots()).toBe(1); // "next" is not in the mocked list either
  });

  it("work that is not a session (a moderator's test run) takes a slot like a session does, and gives it back", async () => {
    const { svc, inner } = service(quietDb(), 1);
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const test = svc.withProvisioningSlot("submission-x:1", async () => {
      order.push("test-started");
      await gate;
      return "created";
    });
    expect(inner.k8sHolders.size).toBe(1);
    // a player's cluster waits for it: the limit on clusters being created at once covers both
    const player = inner.acquireK8sSlot("session-1").then(() => order.push("player-granted"));
    await Promise.resolve();
    expect(order).toEqual(["test-started"]);
    open();
    expect(await test).toBe("created");
    await player;
    expect(order).toEqual(["test-started", "player-granted"]);
  });

  it("the slot of a test run is given back when its work fails", async () => {
    const { svc, inner } = service(quietDb(), 1);
    await expect(svc.withProvisioningSlot("submission-x:1", async () => Promise.reject(new Error("kind create failed")))).rejects.toThrow("kind create failed");
    expect(inner.k8sHolders.size).toBe(0);
  });

  it("the reconciler sweep does not take a test run's slot away: it holds no session row", async () => {
    const prisma = quietDb();
    const { svc, inner } = service(prisma, 2);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const test = svc.withProvisioningSlot("submission-x:1", () => gate);
    prisma.trainingSession.findMany.mockResolvedValue([] as never);
    expect(await svc.releaseStaleK8sSlots()).toBe(0);
    expect(inner.k8sHolders.size).toBe(1);
    open();
    await test;
  });

  it("playerView adds the place in the queue and a wait estimate to a session that waits, and nothing to others", async () => {
    const prisma = {
      trainingSession: {
        ...quietDb().trainingSession,
        findMany: vi.fn(async () => [{ startupMs: 240_000 }, { startupMs: 120_000 }]),
      },
    };
    const { svc, inner } = service(prisma, 1);
    await inner.acquireK8sSlot("a");
    void inner.acquireK8sSlot("b");
    void inner.acquireK8sSlot("c");
    const row = (id: string, status: SessionStatus) => session({ id, status, provider: "kubernetes" });
    expect(await svc.playerView(row("c", SessionStatus.REQUESTED))).toMatchObject({ queuePosition: 2, queueEtaMin: 6 }); // 2 waves of 3 minutes
    expect(await svc.playerView(row("b", SessionStatus.REQUESTED))).toMatchObject({ queuePosition: 1, queueEtaMin: 3 });
    expect(await svc.playerView(row("a", SessionStatus.PROVISIONING))).not.toHaveProperty("queuePosition");
    expect(await svc.playerView(row("zzz", SessionStatus.REQUESTED))).not.toHaveProperty("queuePosition");
  });
});

function session(over: Partial<TrainingSession>): TrainingSession {
  return {
    id: "sess-1",
    userId: "u",
    scenarioId: "sc",
    status: SessionStatus.RUNNING,
    provider: "docker",
    runtimeHandle: { containerId: "secret" },
    startupMs: null,
    startupPhase: null,
    provisioningStartedAt: null,
    checkStartedAt: null,
    clientIp: "203.0.113.1",
    createdAt: new Date(),
    readyAt: null,
    expiresAt: null,
    finishedAt: null,
    result: null,
    checkAttempts: 0,
    hintsUsed: [],
    score: null,
    lastError: null,
    ...over,
  } as TrainingSession;
}

describe("toPlayerView", () => {
  it("shows a failed session as a plain sentence with the session id, never the raw error", () => {
    const stderr = "break script failed (exit 1): kind: failed to create cluster: unix:///run/user/1000/docker.sock /tmp/wom-sub-x";
    const view = toPlayerView(session({ status: SessionStatus.FAILED, lastError: stderr }));
    expect(view.lastError).toContain("sess-1");
    expect(view.lastError).toMatch(/Запусти сценарий заново/);
    expect(view.lastError).not.toContain("docker.sock");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("keeps the messages that are already written for the player", () => {
    expect(toPlayerView(session({ status: SessionStatus.FAILED, lastError: RESTART_MESSAGE })).lastError).toBe(RESTART_MESSAGE);
    expect(toPlayerView(session({ status: SessionStatus.FAILED, lastError: PROVISIONING_TIMEOUT_REASON })).lastError).toMatch(/не успел подняться/);
  });

  it("shows no error for a session that is not FAILED", () => {
    expect(toPlayerView(session({ status: SessionStatus.KILLED, lastError: "disk pressure" })).lastError).toBeNull();
  });

  it("cuts the raw grader output out of the result", () => {
    const view = toPlayerView(session({ result: { status: "error", error: "x", detail: "psql: /etc/secret.conf" } as never }));
    expect(view.result).toEqual({ status: "error", error: "x" });
  });
});
