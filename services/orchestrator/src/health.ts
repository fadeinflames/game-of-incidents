// Degradation signals for GET /health. The platform can look alive (HTTP 200, database up) while the daemon is gone,
// the reconciler is stuck or every new stand fails: these numbers are what an alert can be written against.
import type { PrismaClient } from "@wom/db";
import { SessionStatus } from "@wom/db";
import type { KubernetesState } from "@wom/runtime";

/** why /health says ok:false; the names are stable, an alert can match on them */
export type DegradedReason = "docker-down" | "reconciler-stale" | "failed-sessions-burst" | "kubernetes-unavailable";

export type HealthChecks = {
  /** the sandbox daemon answered a ping within the timeout */
  docker: "ok" | "down";
  /** kubernetes runtime: disabled (not configured), ready, or unavailable (configured, but kind does not answer; kubernetes stands are refused). Absent when the probe has no such signal */
  kubernetes?: KubernetesState;
  /** seconds since the reconciler last finished a pass; null = it has not finished one yet */
  lastReconcileAgoSec: number | null;
  /** sessions that ended FAILED in the last hour */
  failedLastHour: number;
  /** sessions waiting for a provisioning slot */
  queued: number;
  /** 95th percentile of the time from request to ready over the last 3 hours; null = no sessions in that window */
  startupP95Ms: number | null;
  /** what is wrong right now; empty = healthy. GET /health turns a non-empty list into ok:false (still HTTP 200) */
  degraded: DegradedReason[];
};

export type DegradedThresholds = {
  /** the reconciler counts as stuck when its last pass finished longer ago than this */
  reconcilerStaleSec: number;
  /** more FAILED sessions than this in the last hour is a burst */
  failedPerHour: number;
};

export type HealthProbeDeps = {
  prisma: PrismaClient;
  pingDocker: () => Promise<void>;
  lastReconcileAt: () => Date | null;
  /** the registry's view of kind; unset => /health carries no kubernetes field */
  kubernetesState?: () => KubernetesState;
  now?: () => Date;
  /** the database part is cached for this long: /health is polled every few seconds */
  cacheMs?: number;
  dockerTimeoutMs?: number;
  thresholds: DegradedThresholds;
};

const STARTUP_WINDOW_MS = 3 * 60 * 60_000;
const STARTUP_SAMPLE = 200;

/** nearest-rank percentile; null for an empty list */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * lastReconcileAgoSec === null means no pass has finished since the process started: that is only a fault once the
 * process has been up longer than the stale threshold (the first pass runs shortly after start).
 */
export function degradedReasons(c: Omit<HealthChecks, "degraded">, t: DegradedThresholds, uptimeSec: number): DegradedReason[] {
  const reasons: DegradedReason[] = [];
  if (c.docker !== "ok") reasons.push("docker-down");
  if ((c.lastReconcileAgoSec ?? uptimeSec) > t.reconcilerStaleSec) reasons.push("reconciler-stale");
  if (c.failedLastHour > t.failedPerHour) reasons.push("failed-sessions-burst");
  if (c.kubernetes === "unavailable") reasons.push("kubernetes-unavailable");
  return reasons;
}

export function createHealthProbe(deps: HealthProbeDeps): () => Promise<HealthChecks> {
  const now = deps.now ?? (() => new Date());
  const cacheMs = deps.cacheMs ?? 15_000;
  const dockerTimeoutMs = deps.dockerTimeoutMs ?? 2_000;
  const startedAt = now().getTime();
  let cached: { at: number; value: Pick<HealthChecks, "failedLastHour" | "queued" | "startupP95Ms"> } | null = null;

  const pingDocker = async (): Promise<"ok" | "down"> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        deps.pingDocker(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("docker ping timed out")), dockerTimeoutMs);
        }),
      ]);
      return "ok";
    } catch {
      return "down";
    } finally {
      clearTimeout(timer);
    }
  };

  const fromDatabase = async () => {
    const t = now().getTime();
    if (cached && t - cached.at < cacheMs) return cached.value;
    const [failedLastHour, queued, recent] = await Promise.all([
      deps.prisma.trainingSession.count({ where: { status: SessionStatus.FAILED, finishedAt: { gte: new Date(t - 3_600_000) } } }),
      deps.prisma.trainingSession.count({ where: { status: SessionStatus.REQUESTED } }),
      deps.prisma.trainingSession.findMany({
        where: { startupMs: { not: null }, readyAt: { gte: new Date(t - STARTUP_WINDOW_MS) } },
        orderBy: { readyAt: "desc" },
        take: STARTUP_SAMPLE,
        select: { startupMs: true },
      }),
    ]);
    const value = { failedLastHour, queued, startupP95Ms: percentile(recent.map((r) => r.startupMs ?? 0), 95) };
    cached = { at: t, value };
    return value;
  };

  return async () => {
    const [docker, db] = await Promise.all([pingDocker(), fromDatabase()]);
    const last = deps.lastReconcileAt();
    const t = now().getTime();
    const kubernetes = deps.kubernetesState?.();
    const checks = { docker, ...(kubernetes ? { kubernetes } : {}), lastReconcileAgoSec: last ? Math.max(0, Math.round((t - last.getTime()) / 1000)) : null, ...db };
    return { ...checks, degraded: degradedReasons(checks, deps.thresholds, Math.round((t - startedAt) / 1000)) };
  };
}
