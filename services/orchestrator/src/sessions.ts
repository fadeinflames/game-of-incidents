// SessionService (ADR-0003): the only place that changes TrainingSession.status.
import type { PlayerSessionOf, PrismaClient, Scenario, TrainingSession } from "@wom/db";
import { Prisma, SessionStatus } from "@wom/db";
import { createLimiter } from "./concurrency";
import { computeScore, GRADER_ERRORS, parseGraderOutput, playerResult, type GraderResult } from "./grader";
import type { EgressState } from "./guards";
import { logger } from "./logger";
import { pinnedEnvironment, pinnedScenario, snapshotScenario, type PinnedScenario } from "./scenario-snapshot";
import {
  ProvisioningAborted,
  shellFromEnvironment,
  specFromEnvironment,
  type Environment,
  type RuntimeProvider,
  type SandboxHandle,
} from "@wom/runtime";

export { specFromEnvironment };

export const ACTIVE_STATUSES: SessionStatus[] = [
  SessionStatus.REQUESTED,
  SessionStatus.PROVISIONING,
  SessionStatus.READY,
  SessionStatus.RUNNING,
  SessionStatus.CHECKING,
];

export class QuotaError extends Error {
  constructor(
    message: string,
    /** the player's own running session, so the UI can send them back to it instead of to the history */
    public activeSessionId?: string,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}
/** a request that does not fit the state of the session or scenario; `message` is Russian and goes to the player as is */
export class StateError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "StateError";
  }
}

export type SessionServiceOptions = {
  maxSessionsPerUser: number;
  maxSessionsGlobal: number;
  /** cap on concurrent kubernetes (kind) sessions, they are ~10x heavier (ADR-0008) */
  maxK8sSessions?: number;
  maxK8sProvisioning?: number;
  breakTimeoutMs: number;
  graderTimeoutMs: number;
  defaultTtlMin: number;
  /** destroy the sandbox as soon as the grader says "passed" */
  destroyOnFinish?: boolean;
  /** active sessions requested from one client address, across accounts; 0 or unset = no limit */
  maxSessionsPerIp?: number;
  /** used space on the sandbox disk, percent (null = unknown); from diskRefusePct on no session is created */
  diskUsedPct?: () => Promise<number | null>;
  diskRefusePct?: number;
  /** "stale" = the egress guard is not confirming its rules: kubernetes sessions are refused */
  egressState?: () => Promise<EgressState>;
};

export const RESTART_MESSAGE = "Платформа перезапускалась во время подъёма стенда. Запусти сценарий заново.";

function stands(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `запущен ${n} стенд`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `запущено ${n} стенда`;
  return `запущено ${n} стендов`;
}

export class SessionService {
  /** true during a deploy or shutdown: nothing new is accepted, what is running goes on */
  private draining = false;

  constructor(
    private prisma: PrismaClient,
    private runtime: RuntimeProvider,
    private opts: SessionServiceOptions,
  ) {}

  setDraining(on: boolean) {
    this.draining = on;
  }

  isDraining() {
    return this.draining;
  }

  // ---------- create + provision ----------

  async create(userId: string, scenarioId: string, from: { clientIp?: string } = {}): Promise<TrainingSession> {
    if (this.draining) throw new QuotaError("Платформа обновляется. Запусти сценарий снова через минуту.");
    const scenario = await this.prisma.scenario.findUnique({ where: { id: scenarioId } });
    if (!scenario || !scenario.isPublished) throw new StateError("scenario-not-found", "Сценарий не найден или снят с публикации.");
    if (!scenario.environmentJson) throw new StateError("no-environment", "У этого сценария нет живого стенда.");

    let env: Environment | null;
    try {
      env = pinnedEnvironment(pinnedScenario({}, scenario));
    } catch (err) {
      logger.error({ scenarioId, err: err instanceof Error ? err.message : String(err) }, "scenario has an environment that cannot be started");
      throw new StateError("no-environment", "У этого сценария нет живого стенда.");
    }
    const provider = env?.kind === "kubernetes" ? "kubernetes" : "docker";
    await this.assertHostReady(provider);
    const clientIp = from.clientIp || null;
    const maxPerIp = this.opts.maxSessionsPerIp ?? 0;
    const session = await this.prisma.$transaction(async (tx) => {
      // The counts below and the insert are not atomic: two requests at once (a double click, a burst after an
      // announcement) would both pass the limits. One transaction-scoped lock makes the whole check-and-insert a queue.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wom-session-create'))`;
      const [mine, all, k8s, fromIp] = await Promise.all([
        tx.trainingSession.count({ where: { userId, status: { in: ACTIVE_STATUSES } } }),
        tx.trainingSession.count({ where: { status: { in: ACTIVE_STATUSES } } }),
        tx.trainingSession.count({ where: { status: { in: ACTIVE_STATUSES }, provider: "kubernetes" } }),
        clientIp && maxPerIp > 0 ? tx.trainingSession.count({ where: { clientIp, status: { in: ACTIVE_STATUSES } } }) : 0,
      ]);
      if (mine >= this.opts.maxSessionsPerUser) {
        const running = await tx.trainingSession.findFirst({ where: { userId, status: { in: ACTIVE_STATUSES } }, orderBy: { createdAt: "desc" }, select: { id: true } });
        throw new QuotaError("У тебя уже идёт сессия. Вернись к ней или заверши её, чтобы запустить другую.", running?.id);
      }
      if (clientIp && maxPerIp > 0 && fromIp >= maxPerIp) {
        throw new QuotaError(`С твоего адреса уже ${stands(fromIp)}: это предел. Заверши один из них.`);
      }
      if (all >= this.opts.maxSessionsGlobal) throw new QuotaError(`Все ${this.opts.maxSessionsGlobal} слотов заняты. ${await this.etaText(tx, undefined)}`);
      if (provider === "kubernetes" && k8s >= (this.opts.maxK8sSessions ?? 3)) {
        throw new QuotaError(`Все ${this.opts.maxK8sSessions ?? 3} Kubernetes-стендов заняты. ${await this.etaText(tx, "kubernetes")}`);
      }
      // the copy of the scenario this session will run on: a re-import while it runs changes the catalog, not this session
      return tx.trainingSession.create({ data: { userId, scenarioId, status: SessionStatus.REQUESTED, provider, clientIp, scenarioSnapshot: snapshotScenario(scenario) } });
    });
    await this.event(session.id, "status", { to: SessionStatus.REQUESTED });

    this.startProvisioning(session, scenario);
    return session;
  }

  /** fire and forget; the reconciler catches a crash mid-way (PROVISIONING older than the timeout) */
  private startProvisioning(session: TrainingSession, live: Scenario) {
    const pinned = pinnedScenario(session, live);
    try {
      // a queued session of a scenario that lost its stand in a re-import (no snapshot to fall back on) would otherwise sit in REQUESTED until the queue timeout
      if (!pinnedEnvironment(pinned)) throw new Error("scenario has no environment");
    } catch (err) {
      // a stored environment of the wrong shape: fail now, with a row the player sees, not after a queue wait
      logger.error({ sessionId: session.id, err: err instanceof Error ? err.message : String(err) }, "session environment is not valid");
      void this.kill(session.id, "scenario environment is not valid", SessionStatus.FAILED).catch(() => {});
      return;
    }
    void this.provision(session.id, pinned).catch((err) => logger.error({ err, sessionId: session.id }, "provision crashed"));
  }

  /**
   * Refuse before anything is created: a full disk takes the whole platform down, a dead egress guard opens the cluster network (R-7).
   * Public because a moderator's test run of an uploaded scenario builds and starts stands too and goes through the same checks.
   */
  async assertHostReady(provider: "docker" | "kubernetes") {
    const refusePct = this.opts.diskRefusePct ?? 0;
    const usedPct = refusePct > 0 ? ((await this.opts.diskUsedPct?.()) ?? null) : null;
    if (usedPct !== null && usedPct >= refusePct) {
      logger.warn({ usedPct, refusePct }, "session refused: disk pressure");
      throw new QuotaError("Платформа временно не принимает новые сессии: заканчивается место на диске. Мы уже знаем.");
    }
    if (provider === "kubernetes" && (await this.opts.egressState?.()) === "stale") {
      logger.warn({}, "kubernetes session refused: egress guard heartbeat is stale");
      throw new QuotaError("Kubernetes-стенды временно недоступны: защита сети не активна. Попробуй Linux-сценарий или зайди позже.");
    }
  }

  // ---------- restart recovery ----------

  /**
   * Called once at startup, before the API accepts requests. The queue and in-flight provisioning live in the process,
   * so after a restart nobody owns them: half-built stands fail right away (the reconciler sweeps what they left on the
   * daemon), interrupted checks return to RUNNING, queued sessions are provisioned again in their original order.
   */
  async recoverAfterRestart(): Promise<{ failed: number; requeued: number; checks: number }> {
    const interrupted = await this.prisma.trainingSession.findMany({ where: { status: SessionStatus.PROVISIONING }, select: { id: true } });
    let failed = 0;
    for (const s of interrupted) {
      if (this.provisioningAborts.has(s.id)) continue;
      await this.kill(s.id, RESTART_MESSAGE, SessionStatus.FAILED);
      failed++;
    }
    const checks = await this.releaseStuckChecks();
    const queued = await this.prisma.trainingSession.findMany({
      where: { status: SessionStatus.REQUESTED },
      orderBy: { createdAt: "asc" },
      include: { scenario: true },
    });
    for (const s of queued) this.startProvisioning(s, s.scenario);
    return { failed, requeued: queued.length, checks };
  }

  /** CHECKING rows whose grader cannot be running any more go back to RUNNING, so the player can check again */
  async releaseStuckChecks(startedBefore?: Date): Promise<number> {
    const where = {
      status: SessionStatus.CHECKING,
      ...(startedBefore ? { OR: [{ checkStartedAt: { lt: startedBefore } }, { checkStartedAt: null }] } : {}),
    };
    const stuck = await this.prisma.trainingSession.findMany({ where, select: { id: true } });
    let released = 0;
    for (const s of stuck) {
      const moved = await this.prisma.trainingSession.updateMany({ where: { ...where, id: s.id }, data: { status: SessionStatus.RUNNING } });
      if (moved.count !== 1) continue;
      await this.event(s.id, "status", { to: SessionStatus.RUNNING, reason: "check interrupted" });
      released++;
    }
    return released;
  }

  // ---------- provisioning slots (kubernetes clusters are CPU-bound to create; too many at once starve all of them) ----------
  // Holders are kept by session id, not counted: a slot is released for exactly the session that held it (and only once),
  // and the reconciler can drop the ones whose session is gone. A freed slot goes straight to the first waiter, so a
  // request that arrives in between cannot jump the queue.
  private k8sHolders = new Set<string>();
  private k8sWaiters: { sessionId: string; grant: (granted: boolean) => void }[] = [];

  /** false = the session was stopped while it waited */
  private acquireK8sSlot(sessionId: string): Promise<boolean> {
    const max = this.opts.maxK8sProvisioning ?? 2;
    if (this.k8sHolders.size < max) {
      this.k8sHolders.add(sessionId);
      return Promise.resolve(true);
    }
    // not awaited: the waiter must be queued in the same tick, or callers lose their order (restart recovery re-queues by
    // createdAt) and a slot released during the write would find nobody waiting. Only while REQUESTED: a write that lands
    // after the slot was taken must not put "queued" back on a session that is already provisioning
    if (!sessionId.startsWith(EXTERNAL_SLOT_PREFIX)) {
      void this.prisma.trainingSession
        .updateMany({ where: { id: sessionId, status: SessionStatus.REQUESTED }, data: { startupPhase: "queued" } })
        .catch(() => {});
    }
    logger.info({ sessionId, waiting: this.k8sWaiters.length + 1 }, "kubernetes provisioning slot: queued");
    return new Promise<boolean>((grant) => this.k8sWaiters.push({ sessionId, grant }));
  }

  private releaseK8sSlot(sessionId: string) {
    if (!this.k8sHolders.delete(sessionId)) return;
    const next = this.k8sWaiters.shift();
    if (!next) return;
    this.k8sHolders.add(next.sessionId);
    next.grant(true);
  }

  /**
   * Runs `fn` while holding one provisioning slot for work that is not a session (a moderator's test run creates clusters
   * too). The key must not be a session id; the stale-slot sweep leaves such holders alone.
   */
  async withProvisioningSlot<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const holder = `${EXTERNAL_SLOT_PREFIX}${key}`;
    await this.acquireK8sSlot(holder); // nothing cancels an external waiter, so it is always granted in the end
    try {
      return await fn();
    } finally {
      this.releaseK8sSlot(holder);
    }
  }

  /** a stopped session leaves the queue at once instead of waiting for a slot it no longer wants */
  private cancelK8sWaiter(sessionId: string) {
    const i = this.k8sWaiters.findIndex((w) => w.sessionId === sessionId);
    if (i >= 0) this.k8sWaiters.splice(i, 1)[0].grant(false);
  }

  /** slots held for sessions that are no longer REQUESTED/PROVISIONING (their provisioning died without releasing): give them back */
  async releaseStaleK8sSlots(): Promise<number> {
    const held = [...this.k8sHolders].filter((id) => !id.startsWith(EXTERNAL_SLOT_PREFIX));
    if (!held.length) return 0;
    const alive = await this.prisma.trainingSession.findMany({
      where: { id: { in: held }, status: { in: [SessionStatus.REQUESTED, SessionStatus.PROVISIONING] } },
      select: { id: true },
    });
    const aliveIds = new Set(alive.map((s) => s.id));
    let released = 0;
    for (const id of held) {
      if (aliveIds.has(id)) continue;
      logger.warn({ sessionId: id }, "kubernetes provisioning slot released: its session is no longer provisioning");
      this.releaseK8sSlot(id);
      released++;
    }
    return released;
  }

  /** queue position of a session waiting for a cluster slot (1 = next), for the waiting screen */
  queuePosition(sessionId: string): number | null {
    const i = this.k8sWaiters.findIndex((w) => w.sessionId === sessionId);
    return i < 0 ? null : i + 1;
  }

  /** rough wait for the n-th place in the queue: clusters take as long as the recent ones did, `slots` at a time */
  private async queueEtaMin(position: number): Promise<number> {
    const recent = await this.prisma.trainingSession.findMany({
      where: { provider: "kubernetes", startupMs: { not: null } },
      orderBy: { readyAt: "desc" },
      take: 10,
      select: { startupMs: true },
    });
    const avgMs = recent.length ? recent.reduce((sum, r) => sum + (r.startupMs ?? 0), 0) / recent.length : 240_000;
    const slots = Math.max(1, this.opts.maxK8sProvisioning ?? 2);
    return Math.max(1, Math.ceil((Math.ceil(position / slots) * avgMs) / 60_000));
  }

  private async provision(sessionId: string, scenario: PinnedScenario) {
    const env = pinnedEnvironment(scenario);
    if (!env) throw new Error("scenario has no environment");
    if (env.kind !== "kubernetes") return this.provisionNow(sessionId, scenario, env);
    if (!(await this.acquireK8sSlot(sessionId))) return; // stopped while it was queued
    try {
      // provisionNow claims the row only while it is still REQUESTED, so a session stopped in the queue costs nothing
      await this.provisionNow(sessionId, scenario, env);
    } finally {
      this.releaseK8sSlot(sessionId);
    }
  }

  /** in-flight provisioning per session: kill() aborts it so a stopped session does not keep building its sandbox */
  private provisioningAborts = new Map<string, AbortController>();

  /**
   * A session can be killed (user, admin, reconciler) at any moment of provisioning. Rules that keep that clean:
   * every status change here is conditional on the row still being PROVISIONING, so a killed session is never
   * resurrected to RUNNING nor relabelled FAILED; whoever loses that race destroys the sandbox it holds;
   * and a script that died because the kill removed its container is not a provisioning failure.
   */
  private async provisionNow(sessionId: string, scenario: PinnedScenario, env: Environment) {
    const t0 = performance.now();
    const claimed = await this.prisma.trainingSession.updateMany({
      where: { id: sessionId, status: SessionStatus.REQUESTED },
      data: { status: SessionStatus.PROVISIONING, provisioningStartedAt: new Date(), startupPhase: null },
    });
    if (claimed.count !== 1) return; // killed before provisioning started
    await this.event(sessionId, "status", { to: SessionStatus.PROVISIONING });
    const abort = new AbortController();
    this.provisioningAborts.set(sessionId, abort);
    const whileProvisioning = { id: sessionId, status: SessionStatus.PROVISIONING };
    let handle: SandboxHandle | null = null;
    try {
      const setPhase = (phase: string) => {
        void this.prisma.trainingSession.update({ where: { id: sessionId }, data: { startupPhase: phase } }).catch(() => {});
      };
      const spec = specFromEnvironment(env, sessionId);
      spec.onProgress = setPhase;
      spec.signal = abort.signal;
      handle = await this.runtime.create(spec);
      // hand the sandbox over to the row: from here kill() finds and destroys it
      const attached = await this.prisma.trainingSession.updateMany({
        where: whileProvisioning,
        data: { runtimeHandle: handle as unknown as Prisma.InputJsonValue },
      });
      if (attached.count !== 1 || abort.signal.aborted) throw new ProvisioningAborted();
      if (scenario.breakScript) {
        setPhase("break");
        const r = await this.runtime.runScript(handle, scenario.breakScript, { user: "root", timeoutMs: this.opts.breakTimeoutMs, signal: abort.signal });
        if (r.exitCode !== 0 || r.timedOut || r.outputTooLarge) {
          // r.stderr is only the tail of the output (the runtime caps it); the message is cut again before it reaches the row
          throw new Error(`break script failed (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}${r.outputTooLarge ? ", output too large" : ""}): ${r.stderr.slice(0, 500)}`);
        }
      }
      const ttlMin = env.ttlMin ?? this.opts.defaultTtlMin;
      const startupMs = Math.round(performance.now() - t0);
      const now = new Date();
      const ready = await this.prisma.trainingSession.updateMany({
        where: whileProvisioning,
        data: {
          status: SessionStatus.RUNNING,
          readyAt: now,
          expiresAt: new Date(now.getTime() + ttlMin * 60_000),
          startupMs,
        },
      });
      if (ready.count !== 1) throw new ProvisioningAborted();
      await this.event(sessionId, "status", { to: SessionStatus.RUNNING, startupMs });
      logger.info({ sessionId, startupMs }, "session ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // in the background: the slot is released when provision() returns, and the next cluster should not wait for this one to go away
      if (handle) this.destroyInBackground(sessionId, handle, "provisioning failed");
      const failed = await this.prisma.trainingSession.updateMany({
        where: whileProvisioning,
        data: { status: SessionStatus.FAILED, lastError: message, finishedAt: new Date(), runtimeHandle: Prisma.JsonNull },
      });
      if (failed.count !== 1) {
        // the session left PROVISIONING on its own (stopped by the user, killed by an admin, timed out): not a failure
        logger.info({ sessionId, detail: message }, "provisioning stopped: the session was killed meanwhile");
        return;
      }
      logger.error({ sessionId, err: message }, "provisioning failed");
      await this.event(sessionId, "error", { message });
    } finally {
      this.provisioningAborts.delete(sessionId);
    }
  }

  /** minutes until the earliest active session expires: the honest answer to "when can I try again"; null = nobody has a deadline yet */
  private async nextFreeMin(tx: Prisma.TransactionClient | PrismaClient, provider?: string): Promise<number | null> {
    const next = await tx.trainingSession.findFirst({
      where: { status: { in: ACTIVE_STATUSES }, ...(provider ? { provider } : {}), expiresAt: { not: null } },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    });
    return next?.expiresAt ? Math.max(1, Math.ceil((next.expiresAt.getTime() - Date.now()) / 60_000)) : null;
  }

  private async etaText(tx: Prisma.TransactionClient | PrismaClient, provider?: string): Promise<string> {
    const min = await this.nextFreeMin(tx, provider);
    return min === null ? "Попробуй через несколько минут." : `Ближайший освободится не позже чем через ${min} мин, если его не завершат раньше.`;
  }

  /** live occupancy for the catalog; etaMin = when the earliest slot frees up at the latest (null = unknown) */
  async capacity() {
    const [all, k8s, allEta, k8sEta] = await Promise.all([
      this.prisma.trainingSession.count({ where: { status: { in: ACTIVE_STATUSES } } }),
      this.prisma.trainingSession.count({ where: { status: { in: ACTIVE_STATUSES }, provider: "kubernetes" } }),
      this.nextFreeMin(this.prisma),
      this.nextFreeMin(this.prisma, "kubernetes"),
    ]);
    return {
      all: { active: all, max: this.opts.maxSessionsGlobal, etaMin: allEta },
      kubernetes: { active: k8s, max: this.opts.maxK8sSessions ?? 3, etaMin: k8sEta },
    };
  }

  // ---------- read ----------

  get(id: string) {
    return this.prisma.trainingSession.findUnique({ where: { id } });
  }

  /** toPlayerView plus, for a session waiting for a cluster slot, its place in the queue and a rough wait */
  async playerView(s: TrainingSession): Promise<PlayerSessionOf<Date>> {
    const view = toPlayerView(s);
    const queuePosition = s.status === SessionStatus.REQUESTED ? this.queuePosition(s.id) : null;
    if (queuePosition === null) return view;
    return { ...view, queuePosition, queueEtaMin: await this.queueEtaMin(queuePosition).catch(() => null) };
  }

  async getOwned(id: string, userId: string) {
    const s = await this.get(id);
    if (!s || s.userId !== userId) return null;
    return s;
  }

  // ---------- check ----------

  async check(id: string): Promise<{ session: TrainingSession; result: GraderResult }> {
    // atomic RUNNING -> CHECKING guards against double clicks
    const claimed = await this.prisma.trainingSession.updateMany({
      where: { id, status: SessionStatus.RUNNING },
      data: { status: SessionStatus.CHECKING, checkStartedAt: new Date() },
    });
    if (claimed.count !== 1) {
      const now = await this.get(id);
      throw new StateError(
        now?.status === SessionStatus.CHECKING ? "check-running" : "not-running",
        now?.status === SessionStatus.CHECKING ? "Проверка уже идёт: дождись результата." : "Сессия не запущена: возможно, она уже завершена.",
      );
    }
    const session = (await this.get(id))!;
    // the grader the session started with, not the one a later import put in the catalog
    const scenario = await this.pinnedFor(session);
    const handle = session.runtimeHandle as unknown as SandboxHandle | null;

    let result: GraderResult;
    if (!scenario.graderScript || !handle) {
      result = { status: "error", error: GRADER_ERRORS.noGrader };
    } else {
      try {
        const r = await this.runtime.runScript(handle, scenario.graderScript, { user: "root", timeoutMs: this.opts.graderTimeoutMs });
        result = parseGraderOutput(r.stdout, r.exitCode, r.stderr, r.timedOut, r.outputTooLarge);
        if (result.status === "error") logger.warn({ sessionId: id, stderr: r.stderr.slice(0, 500) }, "grader error");
      } catch (err) {
        // the sandbox vanished or the daemon hiccuped: report it as a grader error, never leave the row in CHECKING
        logger.warn({ sessionId: id, err: err instanceof Error ? err.message : String(err) }, "grader could not run");
        result = { status: "error", error: GRADER_ERRORS.couldNotRun };
      }
    }

    const passed = result.status === "ok" && result.passed;
    const penalties = this.hintPenalties(scenario, session.hintsUsed);
    // only a session that is still CHECKING moves on: one that was killed or expired meanwhile keeps that status
    const moved = await this.prisma.trainingSession.updateMany({
      where: { id, status: SessionStatus.CHECKING },
      data: {
        status: passed ? SessionStatus.FINISHED : SessionStatus.RUNNING,
        result: result as unknown as Prisma.InputJsonValue,
        checkAttempts: { increment: 1 },
        ...(passed ? { finishedAt: new Date(), score: computeScore(penalties) } : {}),
      },
    });
    const updated = (await this.get(id))!;
    // the raw grader output (result.detail) stays in the row for the admin pages; the player gets it without
    const shown = playerResult(result) as GraderResult;
    if (moved.count !== 1) return { session: updated, result: shown };
    await this.event(id, "check", { passed, status: result.status });
    // the player is waiting for the verdict, not for the cluster to go away
    if (passed && (this.opts.destroyOnFinish ?? true) && handle) this.destroyInBackground(id, handle, "finished");
    return { session: updated, result: shown };
  }

  private hintPenalties(scenario: PinnedScenario, hintsUsed: number[]): number[] {
    return hintsUsed.map((lvl) => scenario.hints.find((h) => h.level === lvl)?.penalty ?? 0);
  }

  /** the scenario as the session runs on it: its snapshot, or the live row for a session that has none */
  private async pinnedFor(session: TrainingSession): Promise<PinnedScenario> {
    const own = pinnedScenario(session, null);
    if (own.pinned) return own;
    return pinnedScenario(session, await this.prisma.scenario.findUnique({ where: { id: session.scenarioId } }));
  }

  // ---------- hints ----------

  async useHint(id: string, level: number): Promise<{ text: string; penalty: number }> {
    const session = await this.get(id);
    if (!session || session.status !== SessionStatus.RUNNING) throw new StateError("not-running", "Сессия не запущена: подсказки доступны только во время работы.");
    const hint = (await this.pinnedFor(session)).hints.find((h) => h.level === level);
    if (!hint) throw new StateError("no-such-hint", "Такой подсказки нет.");
    // hints open in order: level N requires N-1 already used
    const maxUsed = Math.max(0, ...session.hintsUsed);
    if (level > maxUsed + 1) throw new StateError("hint-order", "Сначала открой предыдущую подсказку.");
    if (!session.hintsUsed.includes(level)) {
      // One write decides who opened the level: a double click sends two requests that both read hintsUsed without it,
      // and a plain push would store the level twice (and charge its penalty twice at the check).
      const opened = await this.prisma.trainingSession.updateMany({
        where: { id, status: SessionStatus.RUNNING, NOT: { hintsUsed: { has: level } } },
        data: { hintsUsed: { push: level } },
      });
      if (opened.count === 1) {
        await this.event(id, "hint", { level, penalty: hint.penalty ?? 0 });
      } else if (!(await this.get(id))?.hintsUsed.includes(level)) {
        // not opened by a parallel request either: the session stopped running in between
        throw new StateError("not-running", "Сессия не запущена: подсказки доступны только во время работы.");
      }
    }
    return { text: hint.text, penalty: hint.penalty ?? 0 };
  }

  // ---------- terminal ----------

  async terminalTarget(id: string): Promise<{ handle: SandboxHandle; user: string; shell: string; cwd: string }> {
    const session = await this.get(id);
    if (!session || session.status !== SessionStatus.RUNNING || !session.runtimeHandle) throw new StateError("not-running", "Сессия не запущена: терминал недоступен.");
    const env = pinnedEnvironment(await this.pinnedFor(session));
    return { handle: session.runtimeHandle as unknown as SandboxHandle, ...shellFromEnvironment(env ?? {}) };
  }

  async openTerminal(id: string, size: { cols: number; rows: number }) {
    const t = await this.terminalTarget(id);
    return this.runtime.openTerminal(t.handle, { user: t.user, shell: t.shell, cwd: t.cwd, cols: size.cols, rows: size.rows });
  }

  // ---------- kill / expire ----------

  /**
   * The row is final when this returns; the sandbox is being destroyed in the background (see destroyInBackground):
   * a kind cluster takes up to two minutes to go, and neither the player's click nor the reconciler's pass nor a
   * provisioning slot should wait for it.
   */
  async kill(id: string, reason: string, status: SessionStatus = SessionStatus.KILLED): Promise<void> {
    // 1. the status first: provisioning that is still running for this session sees the row is no longer its own
    const moved = await this.prisma.trainingSession.updateMany({
      where: { id, status: { in: ACTIVE_STATUSES } },
      data: { status, finishedAt: new Date(), lastError: reason },
    });
    if (moved.count !== 1) return;
    this.cancelK8sWaiter(id);
    await this.event(id, "status", { to: status, reason });
    // 2. stop the sandbox being built (cluster create, break script) instead of letting it run to the end
    this.provisioningAborts.get(id)?.abort();
    // 3. destroy what the row holds; read it after the abort so a handle attached a moment ago is not missed
    const handle = (await this.get(id))?.runtimeHandle as unknown as SandboxHandle | null;
    if (handle) this.destroyInBackground(id, handle, reason);
  }

  // ---------- background destroy ----------

  /** sandboxes being destroyed right now (queued ones too), by handle key; the reconciler must not treat them as orphans */
  private destroying = new Map<string, Promise<void>>();
  private runDestroy = createLimiter(MAX_BACKGROUND_DESTROYS);
  /** destroys that failed since the start; the sandbox stays and the reconciler retries it as an orphan */
  destroyFailures = 0;

  isDestroying(h: SandboxHandle): boolean {
    return this.destroying.has(handleKey(h));
  }

  /**
   * Starts the destroy and returns at once. An error is counted and logged, never thrown: the row is already final.
   * Whatever survives is a sandbox without an active session, which the reconciler finds and retries (and reports
   * loudly when it keeps surviving).
   */
  private destroyInBackground(sessionId: string, handle: SandboxHandle, why: string) {
    const key = handleKey(handle);
    if (this.destroying.has(key)) return;
    const done = this.runDestroy(() => this.runtime.destroy(handle))
      .then(() => this.forgetHandle(sessionId))
      .catch((err) => {
        this.destroyFailures++;
        logger.warn({ err, sessionId, why, failures: this.destroyFailures }, "sandbox destroy failed; the reconciler will retry it");
      })
      .finally(() => this.destroying.delete(key));
    this.destroying.set(key, done);
  }

  /**
   * The sandbox is gone, and with it the reason to keep its handle: for a kubernetes session that is the admin kubeconfig
   * of the cluster. Best effort (the retention job sweeps what this misses); only rows that ended are touched.
   */
  private async forgetHandle(sessionId: string): Promise<void> {
    try {
      await this.prisma.trainingSession.updateMany({
        where: { id: sessionId, status: { notIn: ACTIVE_STATUSES } },
        // the snapshot holds the grader script: nothing reads it once the session has ended
        data: { runtimeHandle: Prisma.DbNull, scenarioSnapshot: Prisma.DbNull },
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, "runtime handle not cleared");
    }
  }

  /** sandboxes being destroyed right now: the disk-pressure relief waits for them before it stops another session */
  destroyingCount(): number {
    return this.destroying.size;
  }

  /** shutdown: gives the destroys in flight a moment to finish (the rest is picked up by the next process's reconciler) */
  async settleDestroys(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.destroying.values()]), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  // ---------- helpers ----------

  /**
   * The audit trail must never stop a state change: a failed write is logged and the operation goes on
   * (a transition has already happened by the time its event is written).
   */
  private async event(sessionId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.sessionEvent.create({ data: { sessionId, kind, payload: payload as Prisma.InputJsonValue } });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId, kind }, "session event not recorded");
    }
  }
}

/** provisioning-slot holders that are not sessions (test runs of submissions) carry this prefix in their key */
const EXTERNAL_SLOT_PREFIX = "ext:";

/** how many sandboxes are destroyed at the same time in the background (a disk-pressure kill stops every session at once) */
const MAX_BACKGROUND_DESTROYS = 4;

/** one sandbox, one key, whichever fields its handle has */
export function handleKey(h: SandboxHandle): string {
  return h.clusterName ?? (h.containerId || h.networkId);
}

export const PROVISIONING_TIMEOUT_REASON = "provisioning timed out";

/**
 * FAILED text for the player. The stored lastError is the raw message of docker/kind or the stderr of break.sh: paths,
 * image names, versions. It stays in the row and on the admin pages; the player gets a sentence and the session id to quote.
 */
function failureText(s: TrainingSession): string {
  if (s.lastError === RESTART_MESSAGE) return RESTART_MESSAGE;
  const ask = `Если повторится, напиши нам и назови номер сессии: ${s.id}.`;
  if (s.lastError === PROVISIONING_TIMEOUT_REASON) return `Стенд не успел подняться за отведённое время. Запусти сценарий заново. ${ask}`;
  return `Не удалось поднять стенд. Запусти сценарий заново. ${ask}`;
}

/** what the player is allowed to see (never runtime handles or scripts) */
export function toPlayerView(s: TrainingSession): PlayerSessionOf<Date> {
  return {
    id: s.id,
    scenarioId: s.scenarioId,
    status: s.status,
    createdAt: s.createdAt,
    readyAt: s.readyAt,
    expiresAt: s.expiresAt,
    finishedAt: s.finishedAt,
    startupMs: s.startupMs,
    startupPhase: s.startupPhase,
    checkAttempts: s.checkAttempts,
    hintsUsed: s.hintsUsed,
    score: s.score,
    result: playerResult(s.result) as GraderResult | null,
    lastError: s.status === SessionStatus.FAILED ? failureText(s) : null,
  };
}
