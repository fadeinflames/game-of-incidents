// Integration tests: real PostgreSQL (DATABASE_URL), fake runtime (no Docker). Skipped without DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient, SessionStatus, SubmissionStatus } from "@wom/db";
import { FakeRuntimeProvider } from "@wom/runtime";
import { Reconciler } from "../../src/reconciler";
import { QuotaError, RESTART_MESSAGE, SessionService, StateError, toPlayerView } from "../../src/sessions";
import { clearEndedRuntimeHandles, purgeSessionEvents } from "../../src/retention";
import { purgeSubmissionArchives, SubmissionRunner } from "../../src/submissions";
import { AccountJanitor } from "../../src/accounts";
import { SESSION_LABEL } from "@wom/runtime";

const hasDb = Boolean(process.env.DATABASE_URL);
const prisma = new PrismaClient();
const PASS = '{"passed":true,"criteria":[{"id":"x","ok":true,"message":"ok"}]}';
const FAIL = '{"passed":false,"criteria":[{"id":"x","ok":false,"message":"nope"}]}';

let userId: string;
let scenarioId: string;

async function waitFor(pred: () => Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting");
}

describe.skipIf(!hasDb)("AccountJanitor (integration)", () => {
  it("disables non-admin accounts idle for longer than the threshold and keeps admins and active users", async () => {
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    const idle = await prisma.user.upsert({ where: { username: "idle-e2e" }, update: { disabledAt: null, lastLoginAt: old, role: "user" }, create: { username: "idle-e2e", passwordHash: "x", lastLoginAt: old } });
    const fresh = await prisma.user.upsert({ where: { username: "fresh-e2e" }, update: { disabledAt: null, lastLoginAt: new Date(), role: "user" }, create: { username: "fresh-e2e", passwordHash: "x", lastLoginAt: new Date() } });
    const boss = await prisma.user.upsert({ where: { username: "boss-e2e" }, update: { disabledAt: null, lastLoginAt: old, role: "admin" }, create: { username: "boss-e2e", passwordHash: "x", lastLoginAt: old, role: "admin" } });
    const n = await new AccountJanitor(prisma, { inactiveDays: 90 }).run();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.user.findUnique({ where: { id: idle.id } }))!.disabledAt).not.toBeNull();
    expect((await prisma.user.findUnique({ where: { id: fresh.id } }))!.disabledAt).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: boss.id } }))!.disabledAt).toBeNull();
    await prisma.user.deleteMany({ where: { username: { in: ["idle-e2e", "fresh-e2e", "boss-e2e"] } } });
  });
});

describe.skipIf(!hasDb)("SessionService + Reconciler (integration)", () => {
  let runtime: FakeRuntimeProvider;
  let svc: SessionService;

  beforeAll(async () => {
    const u = await prisma.user.upsert({
      where: { email: "test@wom.local" },
      update: {},
      create: { email: "test@wom.local", username: "tester", passwordHash: "x" },
    });
    userId = u.id;
    const s = await prisma.scenario.upsert({
      where: { slug: "test-scn" },
      update: { isPublished: true },
      create: {
        slug: "test-scn",
        title: "t",
        summary: "s",
        type: "t",
        contextJson: {},
        eventsJson: [],
        hintsJson: [
          { level: 1, penalty: 0, text: "h1" },
          { level: 2, penalty: 5, text: "h2" },
        ],
        actionsJson: [],
        environmentJson: { image: "img", ttlMin: 30, shell: { sudo: true } },
        isPublished: true, // deleted again in afterAll so it never lingers in the catalogue
        breakScript: "echo break",
        graderScript: "echo check",
      },
    });
    scenarioId = s.id;
  });

  // let background provisioning from the previous test finish before wiping rows (avoids "record not found" noise)
  async function settle() {
    await waitFor(
      async () =>
        (await prisma.trainingSession.count({
          where: { userId, status: { in: [SessionStatus.REQUESTED, SessionStatus.PROVISIONING] } },
        })) === 0,
    ).catch(() => {});
  }

  beforeEach(async () => {
    await settle();
    await prisma.trainingSession.deleteMany({ where: { userId } });
    runtime = new FakeRuntimeProvider();
    runtime.scriptResponder = (script) => ({ exitCode: 0, stdout: script.includes("check") ? FAIL : "", stderr: "", timedOut: false });
    svc = new SessionService(prisma, runtime, {
      maxSessionsPerUser: 1,
      maxSessionsGlobal: 10,
      breakTimeoutMs: 1000,
      graderTimeoutMs: 1000,
      defaultTtlMin: 45,
    });
  });

  afterAll(async () => {
    await settle();
    await prisma.trainingSession.deleteMany({ where: { userId } });
    await prisma.scenarioSubmission.deleteMany({ where: { slug: { startsWith: "test-sub-" } } });
    await prisma.trainingSession.deleteMany({ where: { user: { username: { in: EXTRA_USERS } } } });
    await prisma.user.deleteMany({ where: { username: { in: EXTRA_USERS } } });
    await prisma.scenario.deleteMany({ where: { slug: { in: ["test-scn", "test-k8s"] } } });
    await prisma.$disconnect();
  });

  const EXTRA_USERS = ["queue-a", "queue-b", "ip-a", "ip-b", "ip-c"];
  const extraUser = (username: string) => prisma.user.upsert({ where: { username }, update: {}, create: { username, passwordHash: "x" } });
  const k8sScenario = () =>
    prisma.scenario.upsert({
      where: { slug: "test-k8s" },
      update: { isPublished: true },
      create: {
        slug: "test-k8s",
        title: "k",
        summary: "s",
        type: "t",
        contextJson: {},
        eventsJson: [],
        hintsJson: [],
        actionsJson: [],
        environmentJson: { kind: "kubernetes", image: "tools", ttlMin: 30, cluster: { nodes: 1 }, manifests: [], images: [] },
        isPublished: true, // create() only accepts published scenarios; removed in afterAll
      },
    });
  const baseOpts = { maxSessionsPerUser: 1, maxSessionsGlobal: 10, breakTimeoutMs: 1000, graderTimeoutMs: 1000, defaultTtlMin: 45 };

  it("per-address quota: sessions of different accounts from one address are capped, other addresses and unknown ones are not", async () => {
    const [a, b, c] = await Promise.all([extraUser("ip-a"), extraUser("ip-b"), extraUser("ip-c")]);
    await prisma.trainingSession.deleteMany({ where: { userId: { in: [a.id, b.id, c.id] } } });
    const capped = new SessionService(prisma, runtime, { ...baseOpts, maxSessionsPerIp: 2 });
    const s1 = await capped.create(a.id, scenarioId, { clientIp: "203.0.113.7" });
    expect((await prisma.trainingSession.findUnique({ where: { id: s1.id } }))!.clientIp).toBe("203.0.113.7");
    const s2 = await capped.create(b.id, scenarioId, { clientIp: "203.0.113.7" });
    const refused = capped.create(c.id, scenarioId, { clientIp: "203.0.113.7" });
    await expect(refused).rejects.toBeInstanceOf(QuotaError);
    await expect(refused).rejects.toThrow("С твоего адреса уже запущено 2 стенда: это предел. Заверши один из них.");
    // another address is not affected; neither is a request whose address is unknown
    const s3 = await capped.create(c.id, scenarioId, { clientIp: "203.0.113.8" });
    await capped.kill(s3.id, "test");
    const s4 = await capped.create(c.id, scenarioId);
    await capped.kill(s4.id, "test");
    // a finished session frees the address
    await capped.kill(s2.id, "test");
    const s5 = await capped.create(c.id, scenarioId, { clientIp: "203.0.113.7" });
    // 0 switches the quota off
    const open = new SessionService(prisma, runtime, { ...baseOpts, maxSessionsPerIp: 0 });
    const s6 = await open.create(b.id, scenarioId, { clientIp: "203.0.113.7" });
    for (const s of [s1, s5]) await capped.kill(s.id, "test");
    await open.kill(s6.id, "test");
  });

  it("concurrent creates cannot get past the quotas: two requests at once make one session", async () => {
    const results = await Promise.allSettled([svc.create(userId, scenarioId), svc.create(userId, scenarioId)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.create>>> => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(QuotaError);
    expect((refused[0].reason as QuotaError).activeSessionId).toBe(ok[0].value.id);
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(1);
    await svc.kill(ok[0].value.id, "test");
  });

  it("concurrent creates from one address are capped by the per-address quota too", async () => {
    const [a, b, c] = await Promise.all([extraUser("ip-a"), extraUser("ip-b"), extraUser("ip-c")]);
    await prisma.trainingSession.deleteMany({ where: { userId: { in: [a.id, b.id, c.id] } } });
    const capped = new SessionService(prisma, runtime, { ...baseOpts, maxSessionsPerIp: 1 });
    const results = await Promise.allSettled([a, b, c].map((u) => capped.create(u.id, scenarioId, { clientIp: "203.0.113.50" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "fulfilled") await capped.kill(r.value.id, "test");
  });

  it("a refusal because of the player's own session names that session", async () => {
    const first = await svc.create(userId, scenarioId);
    const refused = svc.create(userId, scenarioId);
    await expect(refused).rejects.toMatchObject({ name: "QuotaError", activeSessionId: first.id });
    await expect(refused).rejects.toThrow("Вернись к ней");
    await svc.kill(first.id, "test");
  });

  it("drain mode: nothing new is accepted, what runs goes on, and switching it off restores creation", async () => {
    const running = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(running.id))?.status === SessionStatus.RUNNING);
    svc.setDraining(true);
    const other = await extraUser("ip-a");
    await prisma.trainingSession.deleteMany({ where: { userId: other.id } });
    await expect(svc.create(other.id, scenarioId)).rejects.toThrow("Платформа обновляется");
    expect((await svc.get(running.id))!.status).toBe(SessionStatus.RUNNING);
    svc.setDraining(false);
    const next = await svc.create(other.id, scenarioId);
    await svc.kill(next.id, "test");
    await svc.kill(running.id, "test");
  });

  it("a failed stand shows the player a plain sentence with the session id, and keeps the raw error for the admin", async () => {
    const rt = new FakeRuntimeProvider();
    rt.scriptResponder = () => ({ exitCode: 1, stdout: "", stderr: "break: unix:///run/user/1000/docker.sock boom", timedOut: false });
    const s2 = new SessionService(prisma, rt, baseOpts);
    const s = await s2.create(userId, scenarioId);
    await waitFor(async () => (await s2.get(s.id))?.status === SessionStatus.FAILED);
    const row = (await s2.get(s.id))!;
    expect(row.lastError).toContain("docker.sock");
    const view = toPlayerView(row);
    expect(view.lastError).toContain(s.id);
    expect(view.lastError).not.toContain("docker.sock");
  });

  it("a break script that throws (the sandbox vanished under it) fails the session and leaves no sandbox", async () => {
    const rt = new FakeRuntimeProvider();
    rt.scriptResponder = () => {
      throw new Error("fake: daemon went away");
    };
    const s2 = new SessionService(prisma, rt, baseOpts);
    const s = await s2.create(userId, scenarioId);
    await waitFor(async () => (await s2.get(s.id))?.status === SessionStatus.FAILED);
    expect((await s2.get(s.id))!.lastError).toContain("daemon went away");
    expect(rt.sandboxes.size).toBe(0);
  });

  it("a session stopped while its check runs stays stopped: the late grader result does not bring it back", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    runtime.scriptDelayMs = 400;
    runtime.scriptResponder = () => ({ exitCode: 0, stdout: PASS, stderr: "", timedOut: false });
    const checking = svc.check(s.id);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.CHECKING);
    await svc.kill(s.id, "killed by user");
    const r = await checking;
    expect(r.session.status).toBe(SessionStatus.KILLED);
    const after = (await svc.get(s.id))!;
    expect(after.status).toBe(SessionStatus.KILLED);
    expect(after.score).toBeNull();
    expect(await prisma.sessionEvent.count({ where: { sessionId: s.id, kind: "check" } })).toBe(0);
  });

  it("a second check while one is running is refused with a text that says so", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    runtime.scriptDelayMs = 300;
    const first = svc.check(s.id);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.CHECKING);
    await expect(svc.check(s.id)).rejects.toMatchObject({ name: "StateError", code: "check-running", message: "Проверка уже идёт: дождись результата." });
    await first;
    await svc.kill(s.id, "test");
    await expect(svc.check(s.id)).rejects.toMatchObject({ code: "not-running" });
  });

  it("the player never gets the raw grader output, the row keeps it", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    runtime.scriptResponder = () => ({ exitCode: 3, stdout: "", stderr: "psql: /etc/secret.conf missing", timedOut: false });
    const r = await svc.check(s.id);
    expect(r.result).toEqual({ status: "error", error: "проверка завершилась с ошибкой (код 3)" });
    const row = (await svc.get(s.id))!;
    expect((row.result as { detail?: string }).detail).toContain("secret.conf");
    expect(toPlayerView(row).result).toEqual({ status: "error", error: "проверка завершилась с ошибкой (код 3)" });
    await svc.kill(s.id, "test");
  });

  it("reconciler: provisioning that outlived its timeout and a request that waited too long in the queue are failed", async () => {
    const [a, b] = await Promise.all([extraUser("queue-a"), extraUser("queue-b")]);
    await prisma.trainingSession.deleteMany({ where: { userId: { in: [a.id, b.id] } } });
    const old = new Date(Date.now() - 10 * 60_000);
    const building = await prisma.trainingSession.create({ data: { userId: a.id, scenarioId, status: SessionStatus.PROVISIONING, provisioningStartedAt: old, createdAt: old } });
    const waiting = await prisma.trainingSession.create({ data: { userId: b.id, scenarioId, status: SessionStatus.REQUESTED, createdAt: old } });
    const rec = new Reconciler(prisma, runtime, svc, { provisioningTimeoutMs: 60_000, queueTimeoutMs: 5 * 60_000, intervalMs: 60_000 });
    expect((await rec.run()).stuck).toBeGreaterThanOrEqual(2);
    for (const id of [building.id, waiting.id]) {
      const row = (await svc.get(id))!;
      expect(row.status).toBe(SessionStatus.FAILED);
      expect(toPlayerView(row).lastError).toMatch(/не успел подняться/);
    }
    // a queued request that is still young is left alone
    const fresh = await prisma.trainingSession.create({ data: { userId: b.id, scenarioId, status: SessionStatus.REQUESTED } });
    await rec.run();
    expect((await svc.get(fresh.id))!.status).toBe(SessionStatus.REQUESTED);
    await prisma.trainingSession.delete({ where: { id: fresh.id } });
  });

  it("reconciler: a sandbox that is still listed but stopped (reboot, daemon restart) ends the session", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    const handle = (await svc.get(s.id))!.runtimeHandle as unknown as { containerId: string };
    const rec = new Reconciler(prisma, runtime, svc, { provisioningTimeoutMs: 60_000, intervalMs: 60_000 });
    expect((await rec.run()).vanished).toBe(0);
    runtime.sandboxes.get(handle.containerId)!.status = "exited";
    expect((await rec.run()).vanished).toBe(1);
    const after = (await svc.get(s.id))!;
    expect(after.status).toBe(SessionStatus.KILLED);
    expect(after.lastError).toBe("sandbox stopped");
    expect(runtime.sandboxes.has(handle.containerId)).toBe(false);
  });

  it("reconciler: records when it last finished a pass", async () => {
    const rec = new Reconciler(prisma, runtime, svc, { provisioningTimeoutMs: 60_000, intervalMs: 60_000 });
    expect(rec.lastRunAt).toBeNull();
    await rec.run();
    expect(Date.now() - rec.lastRunAt!.getTime()).toBeLessThan(5000);
  });

  it("disk guard: at the refuse threshold no session is created; below it and when the usage is unknown creation works", async () => {
    let usedPct: number | null = 85;
    const guarded = new SessionService(prisma, runtime, { ...baseOpts, diskUsedPct: async () => usedPct, diskRefusePct: 85 });
    const refused = guarded.create(userId, scenarioId);
    await expect(refused).rejects.toBeInstanceOf(QuotaError);
    await expect(refused).rejects.toThrow("заканчивается место на диске");
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(0);
    usedPct = null;
    const s1 = await guarded.create(userId, scenarioId);
    await guarded.kill(s1.id, "test");
    usedPct = 84;
    const s2 = await guarded.create(userId, scenarioId);
    await guarded.kill(s2.id, "test");
  });

  it("disk guard: at the kill threshold the reconciler stops the heaviest active session", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    let usedPct = 92;
    const rec = new Reconciler(prisma, runtime, svc, { provisioningTimeoutMs: 60_000, intervalMs: 60_000, diskUsedPct: async () => usedPct, diskKillPct: 93 });
    expect((await rec.run()).diskKilled).toBe(0);
    expect((await svc.get(s.id))!.status).toBe(SessionStatus.RUNNING);
    usedPct = 93;
    expect((await rec.run()).diskKilled).toBeGreaterThanOrEqual(1);
    const after = (await svc.get(s.id))!;
    expect(after.status).toBe(SessionStatus.KILLED);
    expect(after.lastError).toBe("disk pressure");
    expect(runtime.sandboxes.size).toBe(0);
  });

  it("egress guard: a stale heartbeat refuses kubernetes sessions and leaves docker sessions alone", async () => {
    const k8s = await k8sScenario();
    let egress: "ok" | "stale" | "off" = "stale";
    const guarded = new SessionService(prisma, runtime, { ...baseOpts, maxK8sSessions: 5, egressState: async () => egress });
    const refused = guarded.create(userId, k8s.id);
    await expect(refused).rejects.toBeInstanceOf(QuotaError);
    await expect(refused).rejects.toThrow("защита сети не активна");
    expect(await prisma.trainingSession.count({ where: { userId } })).toBe(0);
    const docker = await guarded.create(userId, scenarioId);
    await guarded.kill(docker.id, "test");
    for (const state of ["ok", "off"] as const) {
      egress = state;
      const s = await guarded.create(userId, k8s.id);
      await guarded.kill(s.id, "test");
    }
  });

  it("restart recovery: half-built stands fail with a message, interrupted checks return to RUNNING, queued sessions are provisioned in order", async () => {
    const [a, b] = await Promise.all([extraUser("queue-a"), extraUser("queue-b")]);
    await prisma.trainingSession.deleteMany({ where: { userId: { in: [a.id, b.id] } } });
    // what a dead orchestrator leaves behind: a stand it was building (its sandbox is still on the daemon) ...
    const leftover = runtime.addOrphan("placeholder");
    const building = await prisma.trainingSession.create({
      data: { userId, scenarioId, status: SessionStatus.PROVISIONING, provisioningStartedAt: new Date(), runtimeHandle: { provider: "docker", containerId: leftover, networkId: "n" } },
    });
    // ... and two sessions that were waiting in its in-memory queue
    const first = await prisma.trainingSession.create({ data: { userId: a.id, scenarioId, status: SessionStatus.REQUESTED, createdAt: new Date(Date.now() - 60_000) } });
    const second = await prisma.trainingSession.create({ data: { userId: b.id, scenarioId, status: SessionStatus.REQUESTED, createdAt: new Date(Date.now() - 30_000) } });

    const report = await svc.recoverAfterRestart();
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(report.requeued).toBeGreaterThanOrEqual(2);
    const failed = (await svc.get(building.id))!;
    expect(failed.status).toBe(SessionStatus.FAILED);
    expect(failed.lastError).toBe(RESTART_MESSAGE);
    expect(runtime.sandboxes.has(leftover)).toBe(false);
    await waitFor(async () => (await svc.get(first.id))?.status === SessionStatus.RUNNING && (await svc.get(second.id))?.status === SessionStatus.RUNNING);
    const [r1, r2] = [(await svc.get(first.id))!, (await svc.get(second.id))!];
    expect(r1.provisioningStartedAt!.getTime()).toBeLessThanOrEqual(r2.provisioningStartedAt!.getTime());

    // a check the dead process was running
    await prisma.trainingSession.update({ where: { id: first.id }, data: { status: SessionStatus.CHECKING, checkStartedAt: new Date() } });
    expect((await svc.recoverAfterRestart()).checks).toBeGreaterThanOrEqual(1);
    expect((await svc.get(first.id))!.status).toBe(SessionStatus.RUNNING);
    await svc.kill(first.id, "test");
    await svc.kill(second.id, "test");
  });

  it("reconciler returns a check that outlived the grader timeout to RUNNING and leaves a fresh one alone", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    const rec = new Reconciler(prisma, runtime, svc, { provisioningTimeoutMs: 60_000, intervalMs: 60_000, graderTimeoutMs: 1000 });
    await prisma.trainingSession.update({ where: { id: s.id }, data: { status: SessionStatus.CHECKING, checkStartedAt: new Date() } });
    expect((await rec.run()).checks).toBe(0);
    expect((await svc.get(s.id))!.status).toBe(SessionStatus.CHECKING);
    await prisma.trainingSession.update({ where: { id: s.id }, data: { checkStartedAt: new Date(Date.now() - 62_000) } });
    expect((await rec.run()).checks).toBe(1);
    expect((await svc.get(s.id))!.status).toBe(SessionStatus.RUNNING);
    // the player can check again
    expect((await svc.check(s.id)).session.status).toBe(SessionStatus.RUNNING);
  });

  it("kubernetes provisioning slots: the second cluster waits in REQUESTED (queued) and starts when the first finishes", async () => {
    const k8s = await k8sScenario();
    const a = await extraUser("queue-a");
    const b = await extraUser("queue-b");
    const slow = new FakeRuntimeProvider();
    slow.createDelayMs = 800;
    const queued = new SessionService(prisma, slow, {
      maxSessionsPerUser: 1,
      maxSessionsGlobal: 10,
      maxK8sSessions: 5,
      maxK8sProvisioning: 1,
      breakTimeoutMs: 1000,
      graderTimeoutMs: 1000,
      defaultTtlMin: 45,
    });
    const s1 = await queued.create(a.id, k8s.id);
    const s2 = await queued.create(b.id, k8s.id);
    await waitFor(async () => (await prisma.trainingSession.findUnique({ where: { id: s2.id } }))!.startupPhase === "queued", 2000);
    const mid = await prisma.trainingSession.findUnique({ where: { id: s1.id } });
    expect(mid!.status).toBe(SessionStatus.PROVISIONING);
    expect((await prisma.trainingSession.findUnique({ where: { id: s2.id } }))!.status).toBe(SessionStatus.REQUESTED);
    await waitFor(async () => (await prisma.trainingSession.findUnique({ where: { id: s2.id } }))!.status === SessionStatus.RUNNING, 6000);
    const done2 = await prisma.trainingSession.findUnique({ where: { id: s2.id } });
    expect(done2!.provisioningStartedAt!.getTime()).toBeGreaterThan(done2!.createdAt.getTime() + 500);
    await queued.kill(s1.id, "test");
    await queued.kill(s2.id, "test");
  });

  it("kubernetes queue: a waiting session knows its place, and one that is stopped in the queue leaves it without costing a slot", async () => {
    const k8s = await k8sScenario();
    const [a, b] = await Promise.all([extraUser("queue-a"), extraUser("queue-b")]);
    await prisma.trainingSession.deleteMany({ where: { userId: { in: [a.id, b.id] } } });
    const slow = new FakeRuntimeProvider();
    slow.createDelayMs = 600;
    const queued = new SessionService(prisma, slow, { ...baseOpts, maxK8sSessions: 5, maxK8sProvisioning: 1 });
    const s1 = await queued.create(a.id, k8s.id);
    const s2 = await queued.create(b.id, k8s.id);
    expect(queued.queuePosition(s1.id)).toBeNull();
    expect(queued.queuePosition(s2.id)).toBe(1);
    const view = await queued.playerView((await queued.get(s2.id))!);
    expect(view).toMatchObject({ status: SessionStatus.REQUESTED, queuePosition: 1 });
    expect((view as { queueEtaMin: number }).queueEtaMin).toBeGreaterThanOrEqual(1);
    await queued.kill(s2.id, "killed by user");
    expect(queued.queuePosition(s2.id)).toBeNull();
    await waitFor(async () => (await queued.get(s1.id))?.status === SessionStatus.RUNNING, 5000);
    expect((await queued.get(s2.id))!.status).toBe(SessionStatus.KILLED);
    // the slot is free again: a new cluster starts at once instead of waiting behind the dead request
    const s3 = await queued.create(b.id, k8s.id);
    expect(queued.queuePosition(s3.id)).toBeNull();
    await queued.kill(s3.id, "test");
    await queued.kill(s1.id, "test");
  });

  describe("stop while the environment is still being prepared", () => {
    const service = (rt: FakeRuntimeProvider) =>
      new SessionService(prisma, rt, { maxSessionsPerUser: 1, maxSessionsGlobal: 10, breakTimeoutMs: 5000, graderTimeoutMs: 1000, defaultTtlMin: 45 });
    const row = (id: string) => prisma.trainingSession.findUnique({ where: { id } });
    const errors = (id: string) => prisma.sessionEvent.count({ where: { sessionId: id, kind: "error" } });

    it("during create: the create is aborted at once, the session stays KILLED, no failure is recorded", async () => {
      const rt = new FakeRuntimeProvider();
      rt.createDelayMs = 3000;
      const s2 = service(rt);
      const s = await s2.create(userId, scenarioId);
      await waitFor(async () => (await row(s.id))!.status === SessionStatus.PROVISIONING);
      const t0 = Date.now();
      await s2.kill(s.id, "killed by user");
      // the provisioning slot is released without waiting for the 3 s create to finish
      await waitFor(async () => (s2 as unknown as { provisioningAborts: Map<string, unknown> }).provisioningAborts.size === 0, 1000);
      expect(Date.now() - t0).toBeLessThan(1500);
      const after = (await row(s.id))!;
      expect(after.status).toBe(SessionStatus.KILLED);
      expect(after.lastError).toBe("killed by user");
      expect(rt.sandboxes.size).toBe(0);
      expect(await errors(s.id)).toBe(0);
    });

    it("during create that cannot be interrupted: the finished sandbox is destroyed and the session is not resurrected", async () => {
      const rt = new FakeRuntimeProvider();
      rt.createDelayMs = 400;
      rt.ignoreAbort = true;
      const s2 = service(rt);
      const s = await s2.create(userId, scenarioId);
      await waitFor(async () => (await row(s.id))!.status === SessionStatus.PROVISIONING);
      await s2.kill(s.id, "killed by user");
      await waitFor(async () => (s2 as unknown as { provisioningAborts: Map<string, unknown> }).provisioningAborts.size === 0, 2000);
      const after = (await row(s.id))!;
      expect(after.status).toBe(SessionStatus.KILLED);
      expect(after.readyAt).toBeNull();
      expect(rt.sandboxes.size).toBe(0);
      expect(rt.scripts.length).toBe(0); // break.sh never ran for a session nobody wants
      expect(await errors(s.id)).toBe(0);
    });

    it("during break.sh: the script dies with the sandbox (exit 137) and that is not a provisioning failure", async () => {
      const rt = new FakeRuntimeProvider();
      rt.scriptDelayMs = 600;
      const s2 = service(rt);
      const s = await s2.create(userId, scenarioId);
      await waitFor(async () => (await row(s.id))!.startupPhase === "break" && (await row(s.id))!.runtimeHandle !== null);
      await s2.kill(s.id, "killed by user");
      await waitFor(async () => (s2 as unknown as { provisioningAborts: Map<string, unknown> }).provisioningAborts.size === 0, 2000);
      const after = (await row(s.id))!;
      expect(after.status).toBe(SessionStatus.KILLED);
      expect(after.lastError).toBe("killed by user");
      expect(rt.sandboxes.size).toBe(0);
      expect(await errors(s.id)).toBe(0);
    });

    it("a break script that really fails still marks the session FAILED with its message", async () => {
      const rt = new FakeRuntimeProvider();
      rt.scriptResponder = () => ({ exitCode: 1, stdout: "", stderr: "break: FAILED, boom", timedOut: false });
      const s2 = service(rt);
      const s = await s2.create(userId, scenarioId);
      await waitFor(async () => (await row(s.id))!.status === SessionStatus.FAILED);
      const after = (await row(s.id))!;
      expect(after.lastError).toContain("break: FAILED, boom");
      expect(rt.sandboxes.size).toBe(0);
      expect(await errors(s.id)).toBe(1);
    });
  });

  it("check: a grader that cannot run reports an error and returns the session to RUNNING", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await prisma.trainingSession.findUnique({ where: { id: s.id } }))!.status === SessionStatus.RUNNING);
    const handle = (await prisma.trainingSession.findUnique({ where: { id: s.id } }))!.runtimeHandle as unknown as { containerId: string };
    runtime.vanish(handle.containerId); // runScript now throws "no such sandbox"
    const r = await svc.check(s.id);
    expect(r.result.status).toBe("error");
    expect(r.session.status).toBe(SessionStatus.RUNNING);
  });

  it("provisions: REQUESTED -> RUNNING, runs the break script as root, sets TTL and startupMs", async () => {
    const s = await svc.create(userId, scenarioId);
    expect(s.status).toBe(SessionStatus.REQUESTED);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    const running = (await svc.get(s.id))!;
    expect(running.startupMs).toBeGreaterThanOrEqual(0);
    expect(running.expiresAt!.getTime() - running.readyAt!.getTime()).toBe(30 * 60_000);
    expect(runtime.scripts).toEqual(["echo break"]);
    expect([...runtime.sandboxes.values()][0].spec.labels[SESSION_LABEL]).toBe(s.id);
    expect([...runtime.sandboxes.values()][0].spec.sudo).toBe(true);
  });

  it("enforces one active session per user", async () => {
    await svc.create(userId, scenarioId);
    await expect(svc.create(userId, scenarioId)).rejects.toBeInstanceOf(QuotaError);
  });

  it("marks FAILED and leaves no sandbox when create fails", async () => {
    runtime.failCreate = true;
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.FAILED);
    expect(runtime.sandboxes.size).toBe(0);
    expect((await svc.get(s.id))!.lastError).toMatch(/create failed/);
  });

  it("check: fail keeps RUNNING, pass -> FINISHED with score minus hint penalties and destroys the sandbox", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);

    const first = await svc.check(s.id);
    expect(first.result).toMatchObject({ status: "ok", passed: false });
    expect(first.session.status).toBe(SessionStatus.RUNNING);
    expect(first.session.checkAttempts).toBe(1);

    await svc.useHint(s.id, 1);
    await expect(svc.useHint(s.id, 3)).rejects.toBeInstanceOf(StateError); // no such hint / out of order
    await svc.useHint(s.id, 2);

    runtime.scriptResponder = () => ({ exitCode: 0, stdout: PASS, stderr: "", timedOut: false });
    const second = await svc.check(s.id);
    expect(second.session.status).toBe(SessionStatus.FINISHED);
    expect(second.session.score).toBe(95);
    expect(runtime.sandboxes.size).toBe(0);
    await expect(svc.check(s.id)).rejects.toBeInstanceOf(StateError);
  });

  it("hint: parallel requests for one level open it once and charge its penalty once", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    await svc.useHint(s.id, 1);

    const answers = await Promise.all([svc.useHint(s.id, 2), svc.useHint(s.id, 2), svc.useHint(s.id, 2)]);
    expect(answers.every((a) => a.text === "h2" && a.penalty === 5)).toBe(true);
    expect((await svc.get(s.id))!.hintsUsed).toEqual([1, 2]);
    expect(await prisma.sessionEvent.count({ where: { sessionId: s.id, kind: "hint" } })).toBe(2);

    runtime.scriptResponder = () => ({ exitCode: 0, stdout: PASS, stderr: "", timedOut: false });
    const done = await svc.check(s.id);
    expect(done.session.score).toBe(95);
  });

  it("hint: a session that is no longer running does not take one", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    await svc.kill(s.id, "test");
    await expect(svc.useHint(s.id, 1)).rejects.toBeInstanceOf(StateError);
    expect((await svc.get(s.id))!.hintsUsed).toEqual([]);
  });

  it("grader errors never count as passed", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    runtime.scriptResponder = () => ({ exitCode: 1, stdout: "", stderr: "kaboom", timedOut: false });
    const r = await svc.check(s.id);
    expect(r.result.status).toBe("error");
    expect(r.session.status).toBe(SessionStatus.RUNNING);
  });

  it("a flooded grader output is an error even when its tail looks like a pass", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    runtime.scriptResponder = () => ({ exitCode: -1, stdout: PASS, stderr: "", timedOut: false, outputTooLarge: true });
    const r = await svc.check(s.id);
    expect(r.result).toMatchObject({ status: "error", error: "вывод проверки слишком большой" });
    expect(r.session.status).toBe(SessionStatus.RUNNING);
  });

  it("reconciler expires by TTL, kills sessions whose sandbox vanished and destroys orphans", async () => {
    const s = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    const orphan = runtime.addOrphan("no-such-session");
    const orphan2 = runtime.addOrphan(null);

    const rec = new Reconciler(prisma, runtime, svc, { provisioningTimeoutMs: 60_000, intervalMs: 60_000 });
    let report = await rec.run();
    expect(report).toEqual({ expired: 0, stuck: 0, orphans: 2, vanished: 0, checks: 0, diskKilled: 0 });
    expect(runtime.sandboxes.has(orphan)).toBe(false);
    expect(runtime.sandboxes.has(orphan2)).toBe(false);
    expect((await svc.get(s.id))!.status).toBe(SessionStatus.RUNNING);

    // vanished sandbox
    const handle = (await svc.get(s.id))!.runtimeHandle as { containerId: string };
    runtime.vanish(handle.containerId);
    report = await rec.run();
    expect(report.vanished).toBe(1);
    expect((await svc.get(s.id))!.status).toBe(SessionStatus.KILLED);

    // CLI-owned sandboxes (wom scenario test|run) are left alone while young, reaped when abandoned
    const young = runtime.addOrphan(null);
    runtime.sandboxes.get(young)!.spec.labels["wom.owner"] = "cli";
    const old = runtime.addOrphan(null);
    runtime.sandboxes.get(old)!.spec.labels["wom.owner"] = "cli";
    runtime.sandboxes.get(old)!.createdAt = new Date(Date.now() - 3 * 60 * 60_000);
    report = await rec.run();
    expect(runtime.sandboxes.has(young)).toBe(true);
    expect(runtime.sandboxes.has(old)).toBe(false);
    runtime.vanish(young);

    // TTL
    await prisma.trainingSession.deleteMany({ where: { userId } });
    const s2 = await svc.create(userId, scenarioId);
    await waitFor(async () => (await svc.get(s2.id))?.status === SessionStatus.RUNNING);
    const future = new Reconciler(prisma, runtime, svc, {
      provisioningTimeoutMs: 60_000,
      intervalMs: 60_000,
      now: () => new Date(Date.now() + 31 * 60_000),
    });
    report = await future.run();
    expect(report.expired).toBe(1);
    expect((await svc.get(s2.id))!.status).toBe(SessionStatus.EXPIRED);
    expect(runtime.sandboxes.size).toBe(0);
  });

  describe("retention", () => {
    it("deletes session events older than the limit in batches and keeps the sessions and the young events", async () => {
      const session = await prisma.trainingSession.create({ data: { userId, scenarioId, status: SessionStatus.KILLED, finishedAt: new Date() } });
      const old = new Date(Date.now() - 100 * 24 * 3600_000);
      for (let i = 0; i < 5; i++) await prisma.sessionEvent.create({ data: { sessionId: session.id, kind: "status", createdAt: old } });
      await prisma.sessionEvent.create({ data: { sessionId: session.id, kind: "status" } });
      expect(await purgeSessionEvents(prisma, 90, new Date(), { batchSize: 2, pauseMs: 0 })).toBeGreaterThanOrEqual(5);
      expect(await prisma.sessionEvent.count({ where: { sessionId: session.id } })).toBe(1);
      expect(await prisma.trainingSession.count({ where: { id: session.id } })).toBe(1);
    });

    it("clears the runtime handle of sessions that ended long ago and nothing else", async () => {
      const handle = { provider: "kubernetes", containerId: "c", networkId: "n", clusterName: "wom-k8s-x", kubeconfig: "admin-credentials" };
      const longAgo = new Date(Date.now() - 5 * 24 * 3600_000);
      const [ended, recent, running] = await Promise.all([
        prisma.trainingSession.create({ data: { userId, scenarioId, status: SessionStatus.EXPIRED, finishedAt: longAgo, runtimeHandle: handle } }),
        prisma.trainingSession.create({ data: { userId, scenarioId, status: SessionStatus.KILLED, finishedAt: new Date(), runtimeHandle: handle } }),
        prisma.trainingSession.create({ data: { userId, scenarioId, status: SessionStatus.RUNNING, createdAt: longAgo, runtimeHandle: handle } }),
      ]);
      expect(await clearEndedRuntimeHandles(prisma, 2, new Date(), { pauseMs: 0 })).toBeGreaterThanOrEqual(1);
      const handleOf = async (id: string) => (await prisma.trainingSession.findUnique({ where: { id } }))!.runtimeHandle;
      expect(await handleOf(ended.id)).toBeNull();
      expect(await handleOf(recent.id)).not.toBeNull();
      expect(await handleOf(running.id)).not.toBeNull();
    });
  });

  describe("submissions", () => {
    const stub = new SubmissionRunner(prisma, new FakeRuntimeProvider(), { dockerSocket: "/nonexistent", host: { assertHostReady: async () => {}, withProvisioningSlot: (_key, fn) => fn() } });
    const make = (slug: string, status: SubmissionStatus, updatedAt: Date) =>
      prisma.scenarioSubmission.create({ data: { authorId: userId, slug, title: slug, status, archive: Buffer.from("zipdata"), updatedAt } });

    it("archives of decided submissions older than the limit are emptied, everything else is kept", async () => {
      const old = new Date(Date.now() - 40 * 24 * 3600_000);
      const [oldRejected, oldApproved, oldPending, freshRejected] = await Promise.all([
        make("test-sub-1", SubmissionStatus.REJECTED, old),
        make("test-sub-2", SubmissionStatus.APPROVED, old),
        make("test-sub-3", SubmissionStatus.PASSED, old),
        make("test-sub-4", SubmissionStatus.REJECTED, new Date()),
      ]);
      expect(await purgeSubmissionArchives(prisma, 30)).toBeGreaterThanOrEqual(2);
      const size = async (id: string) => (await prisma.scenarioSubmission.findUnique({ where: { id } }))!.archive.length;
      expect(await size(oldRejected.id)).toBe(0);
      expect(await size(oldApproved.id)).toBe(0);
      expect(await size(oldPending.id)).toBe(7);
      expect(await size(freshRejected.id)).toBe(7);
      // emptying is not a change the moderator made: the row keeps its date
      expect((await prisma.scenarioSubmission.findUnique({ where: { id: oldRejected.id } }))!.updatedAt.getTime()).toBe(old.getTime());
    });

    it("archives of LINT_FAILED submissions are emptied too, in batches", async () => {
      const old = new Date(Date.now() - 200 * 24 * 3600_000);
      const rows = await Promise.all([make("test-sub-6", SubmissionStatus.LINT_FAILED, old), make("test-sub-7", SubmissionStatus.LINT_FAILED, old), make("test-sub-8", SubmissionStatus.LINT_FAILED, old)]);
      expect(await purgeSubmissionArchives(prisma, 180, new Date(), { batchSize: 2, pauseMs: 0 })).toBeGreaterThanOrEqual(3);
      for (const r of rows) expect((await prisma.scenarioSubmission.findUnique({ where: { id: r.id } }))!.archive.length).toBe(0);
    });

    it("a submission left in TESTING that no run owns is failed; one that was touched a moment ago is left", async () => {
      const stuck = await make("test-sub-9", SubmissionStatus.TESTING, new Date(Date.now() - 30 * 60_000));
      const fresh = await make("test-sub-10", SubmissionStatus.TESTING, new Date());
      expect(await stub.failStuck(5 * 60_000)).toContain(stuck.id);
      expect((await prisma.scenarioSubmission.findUnique({ where: { id: stuck.id } }))!.status).toBe(SubmissionStatus.FAILED);
      expect((await prisma.scenarioSubmission.findUnique({ where: { id: fresh.id } }))!.status).toBe(SubmissionStatus.TESTING);
    });

    it("tests interrupted by a restart go back to UPLOADED and their ids are returned for queueing", async () => {
      const t = await make("test-sub-5", SubmissionStatus.TESTING, new Date());
      const ids = await stub.resetStale();
      expect(ids).toContain(t.id);
      expect((await prisma.scenarioSubmission.findUnique({ where: { id: t.id } }))!.status).toBe(SubmissionStatus.UPLOADED);
    });
  });
});
