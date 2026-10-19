// Disk pressure: the heaviest session goes first, one at a time, with time for the freed space to show up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatus, type PrismaClient } from "@wom/db";
import { FakeRuntimeProvider } from "@wom/runtime";
import { logger } from "../../src/logger";
import { pickDiskVictims, Reconciler, type ReconcilerOptions } from "../../src/reconciler";
import type { SessionService } from "../../src/sessions";

type Cand = { id: string; provider: string; createdAt: Date };
const at = (min: number) => new Date(Date.UTC(2026, 9, 3, 10, min));

afterEach(() => vi.restoreAllMocks());

describe("pickDiskVictims", () => {
  const all: Cand[] = [
    { id: "docker-old", provider: "docker", createdAt: at(0) },
    { id: "k8s-new", provider: "kubernetes", createdAt: at(50) },
    { id: "docker-new", provider: "docker", createdAt: at(40) },
    { id: "k8s-old", provider: "kubernetes", createdAt: at(10) },
  ];

  it("kubernetes sessions first, the oldest first within a kind", () => {
    expect(pickDiskVictims(all, 4).map((c) => c.id)).toEqual(["k8s-old", "k8s-new", "docker-old", "docker-new"]);
  });

  it("only as many as asked, and the input is left as it was", () => {
    const copy = [...all];
    expect(pickDiskVictims(all, 1).map((c) => c.id)).toEqual(["k8s-old"]);
    expect(all).toEqual(copy);
    expect(pickDiskVictims(all, 0)).toEqual([]);
  });

  it("equal age: the order is still the same on every call", () => {
    const same: Cand[] = [
      { id: "b", provider: "docker", createdAt: at(0) },
      { id: "a", provider: "docker", createdAt: at(0) },
    ];
    expect(pickDiskVictims(same, 2).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

function setup(candidates: Cand[], over: Partial<ReconcilerOptions> = {}, sessionsOver: Record<string, unknown> = {}) {
  let usedPct: number | null = 95;
  const live = [...candidates];
  const findMany = vi.fn(async () => live.map((c) => ({ ...c })));
  const kill = vi.fn(async (id: string) => {
    live.splice(
      live.findIndex((c) => c.id === id),
      1,
    );
  });
  const sessions = { kill, releaseStaleK8sSlots: async () => 0, releaseStuckChecks: async () => 0, isDestroying: () => false, ...sessionsOver };
  const rec = new Reconciler({ trainingSession: { findMany } } as unknown as PrismaClient, new FakeRuntimeProvider(), sessions as unknown as SessionService, {
    provisioningTimeoutMs: 60_000,
    intervalMs: 60_000,
    diskKillPct: 93,
    diskUsedPct: async () => usedPct,
    diskKillCooldownMs: 0,
    ...over,
  });
  return { rec, kill, findMany, setPct: (v: number | null) => (usedPct = v) };
}

const THREE: Cand[] = [
  { id: "docker-1", provider: "docker", createdAt: at(0) },
  { id: "k8s-1", provider: "kubernetes", createdAt: at(30) },
  { id: "k8s-2", provider: "kubernetes", createdAt: at(10) },
];

describe("relieveDisk", () => {
  it("over the threshold stops ONE session, the oldest kubernetes one, not every active session", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { rec, kill } = setup(THREE);
    expect(await rec.relieveDisk()).toBe(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("k8s-2", "disk pressure", SessionStatus.KILLED);
  });

  it("while the disk stays over the threshold the next measuring stops the next one in order", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { rec, kill } = setup(THREE);
    await rec.relieveDisk();
    await rec.relieveDisk();
    await rec.relieveDisk();
    expect(kill.mock.calls.map((c) => c[0])).toEqual(["k8s-2", "k8s-1", "docker-1"]);
  });

  it("the disk back under the threshold: nobody else is stopped", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { rec, kill, setPct } = setup(THREE);
    await rec.relieveDisk();
    setPct(80);
    expect(await rec.relieveDisk()).toBe(0);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("an unknown disk usage stops nobody", async () => {
    const { rec, kill, setPct } = setup(THREE);
    setPct(null);
    expect(await rec.relieveDisk()).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("waits for the destroy of the last victim: the freed space shows up late", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    let destroying = 0;
    const { rec, kill } = setup(THREE, { diskKillCooldownMs: 0 }, { destroyingCount: () => destroying });
    expect(await rec.relieveDisk()).toBe(1);
    destroying = 1; // the victim's cluster is still being removed
    expect(await rec.relieveDisk()).toBe(0);
    expect(kill).toHaveBeenCalledTimes(1);
    destroying = 0;
    expect(await rec.relieveDisk()).toBe(1);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("a cooldown after a kill holds the next one back", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { rec, kill } = setup(THREE, { diskKillCooldownMs: 60_000 });
    expect(await rec.relieveDisk()).toBe(1);
    expect(await rec.relieveDisk()).toBe(0);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("queued sessions are not candidates (they hold no sandbox): the query leaves REQUESTED out", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const { rec, findMany } = setup(THREE);
    await rec.relieveDisk();
    const where = (findMany.mock.calls[0] as unknown as [{ where: { status: { in: SessionStatus[] } } }])[0].where;
    expect(where.status.in).not.toContain(SessionStatus.REQUESTED);
    expect(where.status.in).toContain(SessionStatus.RUNNING);
  });

  it("no threshold configured: never touches a session", async () => {
    const { rec, kill } = setup(THREE, { diskKillPct: 0 });
    expect(await rec.relieveDisk()).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
