import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@wom/db";
import { createHealthProbe, degradedReasons, percentile, type DegradedThresholds } from "../../src/health";

describe("percentile", () => {
  it("is the nearest rank and null for nothing", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile(Array.from({ length: 20 }, (_, i) => (i + 1) * 100), 95)).toBe(1900);
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});

const THRESHOLDS: DegradedThresholds = { reconcilerStaleSec: 150, failedPerHour: 5 };

function db(over: { failed?: number; queued?: number; startups?: number[] } = {}) {
  return {
    trainingSession: {
      count: vi.fn(async (args: { where: { status: string } }) => (args.where.status === "FAILED" ? (over.failed ?? 0) : (over.queued ?? 0))),
      findMany: vi.fn(async () => (over.startups ?? []).map((startupMs) => ({ startupMs }))),
    },
  };
}

describe("createHealthProbe", () => {
  it("reports the daemon, the reconciler age and the session counters", async () => {
    let t = Date.parse("2026-10-01T12:00:00Z");
    const lastPass = new Date(t - 42_000);
    const prisma = db({ failed: 3, queued: 2, startups: [1000, 2000, 3000, 4000, 60_000] });
    const probe = createHealthProbe({
      prisma: prisma as unknown as PrismaClient,
      pingDocker: async () => {},
      lastReconcileAt: () => lastPass,
      now: () => new Date(t),
      thresholds: THRESHOLDS,
    });
    expect(await probe()).toEqual({ docker: "ok", lastReconcileAgoSec: 42, failedLastHour: 3, queued: 2, startupP95Ms: 60_000, degraded: [] });
    // the database part is cached between polls, the daemon and the reconciler age are not
    t += 5_000;
    expect((await probe()).lastReconcileAgoSec).toBe(47);
    expect(prisma.trainingSession.count).toHaveBeenCalledTimes(2);
    t += 20_000;
    await probe();
    expect(prisma.trainingSession.count).toHaveBeenCalledTimes(4);
  });

  it("a daemon that errors or hangs is down, and a reconciler that never ran has no age", async () => {
    const hang = createHealthProbe({ prisma: db() as unknown as PrismaClient, pingDocker: () => new Promise(() => {}), lastReconcileAt: () => null, dockerTimeoutMs: 30, thresholds: THRESHOLDS });
    expect(await hang()).toMatchObject({ docker: "down", lastReconcileAgoSec: null, startupP95Ms: null, degraded: ["docker-down"] });
    const broken = createHealthProbe({ prisma: db() as unknown as PrismaClient, pingDocker: async () => Promise.reject(new Error("ECONNREFUSED")), lastReconcileAt: () => null, thresholds: THRESHOLDS });
    expect((await broken()).docker).toBe("down");
  });
});

describe("degradedReasons", () => {
  const healthy = { docker: "ok" as const, lastReconcileAgoSec: 10, failedLastHour: 0, queued: 0, startupP95Ms: null };

  it("is empty for a healthy platform and at the thresholds themselves", () => {
    expect(degradedReasons(healthy, THRESHOLDS, 3600)).toEqual([]);
    expect(degradedReasons({ ...healthy, lastReconcileAgoSec: 150, failedLastHour: 5 }, THRESHOLDS, 3600)).toEqual([]);
  });

  it("names a dead daemon, a stale reconciler and a burst of FAILED sessions, all at once if need be", () => {
    expect(degradedReasons({ ...healthy, docker: "down" }, THRESHOLDS, 3600)).toEqual(["docker-down"]);
    expect(degradedReasons({ ...healthy, lastReconcileAgoSec: 151 }, THRESHOLDS, 3600)).toEqual(["reconciler-stale"]);
    expect(degradedReasons({ ...healthy, failedLastHour: 6 }, THRESHOLDS, 3600)).toEqual(["failed-sessions-burst"]);
    expect(degradedReasons({ docker: "down", lastReconcileAgoSec: 999, failedLastHour: 50, queued: 0, startupP95Ms: null }, THRESHOLDS, 3600)).toEqual([
      "docker-down",
      "reconciler-stale",
      "failed-sessions-burst",
    ]);
  });

  it("a reconciler that has not finished a pass yet is a fault only once the process has been up long enough", () => {
    const fresh = { ...healthy, lastReconcileAgoSec: null };
    expect(degradedReasons(fresh, THRESHOLDS, 20)).toEqual([]);
    expect(degradedReasons(fresh, THRESHOLDS, 151)).toEqual(["reconciler-stale"]);
  });
});

describe("createHealthProbe degradation", () => {
  it("reads the reconciler age and the FAILED counter against the thresholds", async () => {
    const t = Date.parse("2026-10-01T12:00:00Z");
    const probe = createHealthProbe({
      prisma: db({ failed: 9 }) as unknown as PrismaClient,
      pingDocker: async () => {},
      lastReconcileAt: () => new Date(t - 400_000),
      now: () => new Date(t),
      thresholds: THRESHOLDS,
    });
    expect((await probe()).degraded).toEqual(["reconciler-stale", "failed-sessions-burst"]);
  });
});

describe("kubernetes in /health", () => {
  const healthy = { docker: "ok" as const, lastReconcileAgoSec: 10, failedLastHour: 0, queued: 0, startupP95Ms: null };

  it("an unavailable kubernetes runtime degrades the platform, a disabled or ready one does not", () => {
    expect(degradedReasons({ ...healthy, kubernetes: "unavailable" }, THRESHOLDS, 3600)).toEqual(["kubernetes-unavailable"]);
    expect(degradedReasons({ ...healthy, kubernetes: "ready" }, THRESHOLDS, 3600)).toEqual([]);
    expect(degradedReasons({ ...healthy, kubernetes: "disabled" }, THRESHOLDS, 3600)).toEqual([]);
  });

  it("the probe carries the field when it is given a source for it, and leaves it out otherwise", async () => {
    let state: "ready" | "unavailable" = "ready";
    const probe = createHealthProbe({ prisma: db() as unknown as PrismaClient, pingDocker: async () => {}, lastReconcileAt: () => new Date(), kubernetesState: () => state, thresholds: THRESHOLDS });
    expect(await probe()).toMatchObject({ kubernetes: "ready", degraded: [] });
    state = "unavailable";
    expect(await probe()).toMatchObject({ kubernetes: "unavailable", degraded: ["kubernetes-unavailable"] });
    const without = createHealthProbe({ prisma: db() as unknown as PrismaClient, pingDocker: async () => {}, lastReconcileAt: () => new Date(), thresholds: THRESHOLDS });
    expect(await without()).not.toHaveProperty("kubernetes");
  });
});
