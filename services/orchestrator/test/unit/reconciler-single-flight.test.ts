import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@wom/db";
import type { RuntimeProvider } from "@wom/runtime";
import { Reconciler } from "../../src/reconciler";
import type { SessionService } from "../../src/sessions";

describe("Reconciler.run", () => {
  it("a pass that is already running is shared, not started twice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const findMany = vi.fn(async () => {
      await gate;
      return [];
    });
    const prisma = { trainingSession: { findMany } } as unknown as PrismaClient;
    const runtime = { list: async () => [] } as unknown as RuntimeProvider;
    const sessions = { releaseStaleK8sSlots: async () => {}, releaseStuckChecks: async () => 0 } as unknown as SessionService;
    const rec = new Reconciler(prisma, runtime, sessions, { provisioningTimeoutMs: 1000, intervalMs: 1000 });

    const a = rec.run();
    const b = rec.run();
    release();
    await Promise.all([a, b]);
    // expired, stuck and active lookups: three queries for one pass
    expect(findMany).toHaveBeenCalledTimes(3);

    await rec.run();
    expect(findMany).toHaveBeenCalledTimes(6);
  });
});
