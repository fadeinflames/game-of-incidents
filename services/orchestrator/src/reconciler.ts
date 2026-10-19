// Reconciler (ADR-0003): runs at startup and every N seconds; makes DB state and runtime state agree.
import type { PrismaClient } from "@wom/db";
import { SessionStatus } from "@wom/db";
import { logger } from "./logger";
import { CLI_SANDBOX_MAX_AGE_MS, OWNER_LABEL, type ListedSandbox, type RuntimeExtras, type RuntimeProvider, type SandboxHandle } from "@wom/runtime";
import { mapLimit } from "./concurrency";
import { ACTIVE_STATUSES, handleKey, PROVISIONING_TIMEOUT_REASON, type SessionService } from "./sessions";

export type ReconcileReport = { expired: number; stuck: number; orphans: number; vanished: number; checks: number; diskKilled: number };

/** a check may legitimately run for graderTimeoutMs plus the time to start and remove its runner container */
const CHECK_GRACE_MS = 60_000;
/** sessions stopped and sandboxes destroyed at the same time within one pass */
const BATCH = 4;
/** an orphan that is still there after this many destroy attempts is a leak somebody has to look at */
const ORPHAN_ALERT_ATTEMPTS = 3;
/** a pass that has been destroying orphans this long leaves the rest for the next one: /health calls a pass that never finishes stale */
const ORPHAN_PASS_BUDGET_MS = 90_000;
const NETWORK_SWEEP_EVERY_MS = 5 * 60_000;
/** how often the disk is measured between two passes (a pass is every 30 s; a kind create can fill a disk faster than that) */
const DISK_CHECK_EVERY_MS = 5_000;
/** after a session was stopped for the disk, wait this long (and for its sandbox to be gone) before stopping another: the space is freed late */
const DISK_KILL_COOLDOWN_MS = 20_000;
/** ...but not longer than this: a destroy that hangs must not leave the disk filling up */
const DISK_KILL_MAX_WAIT_MS = 2 * 60_000;

export type DiskVictimCandidate = { id: string; provider: string; createdAt: Date };

/**
 * Who goes first when the disk is about to fill up: kubernetes sessions (a kind cluster writes images and layers to the
 * disk many times over what a plain sandbox does), and among the same kind the oldest, which has been writing the longest.
 */
export function pickDiskVictims<T extends DiskVictimCandidate>(candidates: readonly T[], count: number): T[] {
  const weight = (c: T) => (c.provider === "kubernetes" ? 0 : 1);
  return [...candidates]
    .sort((a, b) => weight(a) - weight(b) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, count));
}
const NETWORK_MIN_AGE_MS = 10 * 60_000;

export type ReconcilerOptions = {
  provisioningTimeoutMs: number;
  queueTimeoutMs?: number;
  intervalMs: number;
  now?: () => Date;
  /** set => a session in CHECKING for longer than this plus a grace period returns to RUNNING */
  graderTimeoutMs?: number;
  /** used space on the sandbox disk, percent (null = unknown); from diskKillPct on every active session is stopped */
  diskUsedPct?: () => Promise<number | null>;
  diskKillPct?: number;
  /** disk measuring period between passes (default 5 s) */
  diskCheckEveryMs?: number;
  /** sessions stopped per measuring while the disk stays over diskKillPct (default 1) */
  diskKillBatch?: number;
  diskKillCooldownMs?: number;
  /** time one pass may spend destroying orphans (default 90 s) */
  orphanBudgetMs?: number;
  /** how often empty sandbox networks are swept (default 5 min) and how old they must be to go (default: twice the provisioning timeout, at least 10 min) */
  networkSweepEveryMs?: number;
  networkMinAgeMs?: number;
};

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<ReconcileReport> | null = null;
  /** when the last pass finished; /health reports its age, a stuck reconciler is invisible otherwise */
  lastRunAt: Date | null = null;
  /** destroy attempts per orphan, by handle key; an entry lives while the orphan is still listed */
  private orphanAttempts = new Map<string, number>();
  private networksSweptAt = 0;
  private k8sSeen: string | undefined;
  private diskTimer: NodeJS.Timeout | null = null;
  private diskRelief: Promise<number> | null = null;
  private lastDiskKillAt = 0;

  constructor(
    private prisma: PrismaClient,
    // the registry has the extras (kubernetes state, network sweep); a plain provider is treated as always ready
    private runtime: RuntimeProvider & Partial<RuntimeExtras>,
    private sessions: SessionService,
    private opts: ReconcilerOptions,
  ) {}

  start() {
    void this.runSafe();
    this.timer = setInterval(() => void this.runSafe(), this.opts.intervalMs);
    this.timer.unref();
    if ((this.opts.diskKillPct ?? 0) > 0 && this.opts.diskUsedPct) {
      this.diskTimer = setInterval(() => {
        this.relieveDisk().catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, "disk relief failed"));
      }, this.opts.diskCheckEveryMs ?? DISK_CHECK_EVERY_MS);
      this.diskTimer.unref();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.diskTimer) clearInterval(this.diskTimer);
  }

  /**
   * The disk is about to fill up and the sandboxes share it with the platform: stops the heaviest session(s), not all of
   * them, and looks again (the freed space shows up late, so it waits for the destroy and a short cooldown first).
   * One call at a time, whoever asks (the timer or the pass). Returns how many sessions were stopped.
   */
  relieveDisk(): Promise<number> {
    this.diskRelief ??= this.doRelieveDisk().finally(() => {
      this.diskRelief = null;
    });
    return this.diskRelief;
  }

  private async doRelieveDisk(): Promise<number> {
    const killPct = this.opts.diskKillPct ?? 0;
    if (killPct <= 0 || !this.opts.diskUsedPct) return 0;
    const usedPct = await this.opts.diskUsedPct();
    if (usedPct === null || usedPct < killPct) return 0;
    const since = Date.now() - this.lastDiskKillAt;
    const cooldown = this.opts.diskKillCooldownMs ?? DISK_KILL_COOLDOWN_MS;
    const destroying = this.sessions.destroyingCount?.() ?? 0;
    if (since < cooldown || (destroying > 0 && since < DISK_KILL_MAX_WAIT_MS)) return 0;

    const candidates = await this.prisma.trainingSession.findMany({
      // a queued session has no sandbox yet: stopping it frees nothing
      where: { status: { in: ACTIVE_STATUSES.filter((s) => s !== SessionStatus.REQUESTED) } },
      select: { id: true, provider: true, createdAt: true },
    });
    const victims = pickDiskVictims(candidates, this.opts.diskKillBatch ?? 1);
    if (!victims.length) {
      logger.error({ usedPct, killPct }, "disk pressure: nothing to stop, the disk is filled by something else");
      return 0;
    }
    this.lastDiskKillAt = Date.now();
    await this.killAll(victims.map((v) => v.id), "disk pressure", SessionStatus.KILLED);
    logger.error({ usedPct, killPct, killed: victims.map((v) => v.id), providers: victims.map((v) => v.provider), activeLeft: candidates.length - victims.length }, "disk pressure: stopped the heaviest session");
    return victims.length;
  }

  private async runSafe() {
    if (this.inflight) return;
    try {
      const report = await this.run();
      if (Object.values(report).some(Boolean)) logger.info({ ...report }, "reconcile");
    } catch (err) {
      logger.error({ err }, "reconcile failed");
    }
  }

  /** One pass at a time, whoever asks (the timer or POST /admin/reconcile): a caller that arrives meanwhile gets the pass already running. */
  run(): Promise<ReconcileReport> {
    this.inflight ??= this.pass().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** the sessions are stopped a few at a time: one slow row must not hold up the rest of the pass */
  private async killAll(ids: string[], reason: string, status: SessionStatus): Promise<void> {
    await mapLimit(ids, BATCH, (id) => this.sessions.kill(id, reason, status));
  }

  /** a kubernetes runtime that does not answer is probed again; returns whether kubernetes sessions can be judged */
  private async kubernetesReady(): Promise<boolean> {
    const state = this.runtime.kubernetesState?.();
    if (state === "unavailable") await this.runtime.probeKubernetes?.().catch(() => {});
    const now = this.runtime.kubernetesState?.() ?? "ready";
    if (now !== this.k8sSeen) {
      if (now === "unavailable") logger.error({}, "kubernetes runtime is not available: kubernetes sessions are left alone until kind answers");
      else if (now === "ready" && this.k8sSeen === "unavailable") logger.info({}, "kubernetes runtime is available again");
      this.k8sSeen = now;
    }
    return now === "ready";
  }

  private async pass(): Promise<ReconcileReport> {
    const now = this.opts.now?.() ?? new Date();
    const report: ReconcileReport = { expired: 0, stuck: 0, orphans: 0, vanished: 0, checks: 0, diskKilled: 0 };

    // 0. the disk is about to fill up (the timer between passes does the same, every few seconds)
    report.diskKilled = await this.relieveDisk();

    // 1. TTL reached
    const expired = await this.prisma.trainingSession.findMany({
      where: { status: { in: [SessionStatus.READY, SessionStatus.RUNNING, SessionStatus.CHECKING] }, expiresAt: { lt: now } },
      select: { id: true },
    });
    await this.killAll(expired.map((s) => s.id), "ttl expired", SessionStatus.EXPIRED);
    report.expired = expired.length;

    // 2. provisioning stuck (orchestrator crashed mid-way)
    const stuck = await this.prisma.trainingSession.findMany({
      where: {
        OR: [
          // provisioning that actually started and never finished
          { status: SessionStatus.PROVISIONING, provisioningStartedAt: { lt: new Date(now.getTime() - this.opts.provisioningTimeoutMs) } },
          { status: SessionStatus.PROVISIONING, provisioningStartedAt: null, createdAt: { lt: new Date(now.getTime() - this.opts.provisioningTimeoutMs) } },
          // requested but never picked up (orchestrator restarted while it was queued) or queued for too long
          { status: SessionStatus.REQUESTED, createdAt: { lt: new Date(now.getTime() - (this.opts.queueTimeoutMs ?? this.opts.provisioningTimeoutMs * 4)) } },
        ],
      },
      select: { id: true },
    });
    await this.killAll(stuck.map((s) => s.id), PROVISIONING_TIMEOUT_REASON, SessionStatus.FAILED);
    report.stuck = stuck.length;

    // 2a. a check that outlived its grader (the final write failed, the runner hung): the player may check again
    if (this.opts.graderTimeoutMs !== undefined) {
      report.checks = await this.sessions.releaseStuckChecks(new Date(now.getTime() - this.opts.graderTimeoutMs - CHECK_GRACE_MS));
    }

    // 2b. a provisioning slot whose session is gone (provisioning died without releasing it) must not block the queue for good
    await this.sessions.releaseStaleK8sSlots().catch((err) => logger.warn({ err }, "stale slot sweep failed"));

    // 3. sandboxes without an active session -> destroy; 4. active sessions whose sandbox is gone or stopped -> KILLED
    // The runtime is listed BEFORE the active sessions are read. The other way round, a stand that is created and
    // attached between the two reads is in the list but not in the snapshot, and is destroyed as an orphan.
    // In this order the opposite can happen instead (a session is in the snapshot but its sandbox is not in the list),
    // which is why a session that became ready after the listing started is not judged until the next pass.
    const k8sReady = await this.kubernetesReady();
    const listedAt = Date.now();
    const listed = await this.runtime.list();
    const k8sListed = k8sReady && (this.runtime.kubernetesState?.() ?? "ready") === "ready";
    const active = await this.prisma.trainingSession.findMany({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true, status: true, runtimeHandle: true, readyAt: true },
    });
    const activeIds = new Set(active.map((s) => s.id));
    const seenContainers = new Set<string>();
    const orphans: { sb: ListedSandbox; why: string }[] = [];
    for (const sb of listed) {
      seenContainers.add(sb.handle.containerId);
      // sandboxes of `wom scenario test|run` are not sessions: leave them alone unless they are clearly abandoned
      if (sb.labels[OWNER_LABEL] === "cli") {
        if (now.getTime() - sb.createdAt.getTime() > CLI_SANDBOX_MAX_AGE_MS) orphans.push({ sb, why: "stale cli sandbox" });
        continue;
      }
      if (!sb.sessionId || !activeIds.has(sb.sessionId)) {
        // the session was stopped a moment ago and its sandbox is on its way out already
        if (this.sessions.isDestroying?.(sb.handle)) continue;
        orphans.push({ sb, why: sb.sessionId ? "its session is not active" : "no session" });
      }
    }
    report.orphans = await this.destroyOrphans(orphans);

    let skippedK8s = 0;
    for (const s of active) {
      const handle = s.runtimeHandle as unknown as SandboxHandle | null;
      if (!handle) continue; // still provisioning, no container yet
      if (s.status !== SessionStatus.RUNNING && s.status !== SessionStatus.READY && s.status !== SessionStatus.CHECKING) continue;
      // ready after the list was taken: its sandbox cannot be in it
      if (s.readyAt && s.readyAt.getTime() >= listedAt) continue;
      // kind did not answer, so the list holds no kubernetes sandboxes: absence proves nothing, and killing the session would leave its cluster behind
      if (handle.provider === "kubernetes" && !k8sListed) {
        skippedK8s++;
        continue;
      }
      if (!seenContainers.has(handle.containerId)) {
        await this.sessions.kill(s.id, "sandbox disappeared", SessionStatus.KILLED);
        report.vanished++;
        continue;
      }
      // list() includes stopped containers: after a reboot or a daemon restart the sandbox is still there, but dead
      const state = await this.runtime.status(handle).catch(() => "running" as const);
      // only a positive "exited": for kubernetes status() reads `kind get clusters`, and one failed call under load reads as "missing"
      if (state === "exited") {
        await this.sessions.kill(s.id, "sandbox stopped", SessionStatus.KILLED);
        report.vanished++;
      }
    }
    if (skippedK8s) logger.warn({ skipped: skippedK8s }, "kubernetes sessions were not checked: the kubernetes runtime is not available");

    await this.sweepNetworks();
    this.lastRunAt = new Date();
    return report;
  }

  /**
   * Destroys the orphans a few at a time and returns how many went. Each one is logged; one that was already tried in
   * earlier passes and is still there is logged as an error, because a plain retry is not fixing it.
   */
  private async destroyOrphans(orphans: { sb: ListedSandbox; why: string }[]): Promise<number> {
    const keys = new Set(orphans.map((o) => handleKey(o.sb.handle)));
    for (const k of this.orphanAttempts.keys()) if (!keys.has(k)) this.orphanAttempts.delete(k);
    if (!orphans.length) return 0;

    const startedAt = Date.now();
    const budget = this.opts.orphanBudgetMs ?? ORPHAN_PASS_BUDGET_MS;
    let destroyed = 0;
    let tried = 0;
    await mapLimit(
      orphans,
      BATCH,
      async ({ sb, why }) => {
        tried++;
        const key = handleKey(sb.handle);
        const attempt = (this.orphanAttempts.get(key) ?? 0) + 1;
        this.orphanAttempts.set(key, attempt);
        const fields = {
          why,
          attempt,
          sessionId: sb.sessionId,
          provider: sb.handle.provider,
          containerId: sb.handle.containerId || undefined,
          clusterName: sb.handle.clusterName,
          ageSec: Math.round((Date.now() - sb.createdAt.getTime()) / 1000),
        };
        if (attempt >= ORPHAN_ALERT_ATTEMPTS) logger.error(fields, "orphan sandbox survived several destroy attempts");
        else logger.warn(fields, "orphan sandbox: destroying");
        try {
          await this.runtime.destroy(sb.handle);
          destroyed++;
        } catch (err) {
          logger.warn({ ...fields, err: err instanceof Error ? err.message : String(err) }, "orphan destroy failed");
        }
      },
      () => Date.now() - startedAt > budget,
    );
    if (tried < orphans.length) logger.warn({ left: orphans.length - tried }, "orphan destroy: time budget of the pass used up, the rest waits for the next one");
    return destroyed;
  }

  /** docker networks of sandboxes that have no container; a destroy that could not remove its network leaves one behind (each holds an address range) */
  private async sweepNetworks() {
    if (!this.runtime.removeOrphanNetworks) return;
    const every = this.opts.networkSweepEveryMs ?? NETWORK_SWEEP_EVERY_MS;
    if (Date.now() - this.networksSweptAt < every) return;
    this.networksSweptAt = Date.now();
    // a network is empty for a while before its first container joins (a cluster is created for minutes): only old ones are orphans
    const minAge = this.opts.networkMinAgeMs ?? Math.max(NETWORK_MIN_AGE_MS, this.opts.provisioningTimeoutMs * 2);
    try {
      const removed = await this.runtime.removeOrphanNetworks(minAge);
      if (removed) logger.warn({ removed }, "orphan sandbox networks removed");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "orphan network sweep failed");
    }
  }
}
