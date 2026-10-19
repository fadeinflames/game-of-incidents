// AccountJanitor (owner decision 2026-09-30: accounts idle for 7 days are disabled): the cutoff, who is spared, what goes
// with a disabled account. A stubbed database, no PostgreSQL.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@wom/db";
import { AccountJanitor } from "../../src/accounts";
import { logger } from "../../src/logger";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-10-10T12:00:00Z");

afterEach(() => vi.restoreAllMocks());

function stub(stale: { id: string }[]) {
  const prisma = {
    user: {
      findMany: vi.fn(async (_args: unknown) => stale),
      updateMany: vi.fn(async (args: unknown) => args),
    },
    session: { deleteMany: vi.fn(async (args: unknown) => args) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  };
  return { prisma, db: prisma as unknown as PrismaClient };
}

describe("AccountJanitor.run", () => {
  it("looks for users whose last login, or registration if they never logged in, is older than 7 days, and never for admins or the disabled", async () => {
    const { prisma, db } = stub([]);
    await new AccountJanitor(db, { inactiveDays: 7, now: () => NOW }).run();
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    expect(prisma.user.findMany.mock.calls[0][0]).toEqual({
      where: {
        disabledAt: null,
        role: { not: "admin" },
        OR: [{ lastLoginAt: { lt: cutoff } }, { lastLoginAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true },
    });
  });

  it("touches nothing when nobody is idle", async () => {
    const { prisma, db } = stub([]);
    expect(await new AccountJanitor(db, { inactiveDays: 7, now: () => NOW }).run()).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("disables the idle accounts and drops their browser sessions in one transaction", async () => {
    const { prisma, db } = stub([{ id: "a" }, { id: "b" }]);
    expect(await new AccountJanitor(db, { inactiveDays: 7, now: () => NOW }).run()).toBe(2);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } }, data: { disabledAt: NOW } });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: { in: ["a", "b"] } } });
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2); // a disabled account never keeps a working cookie, and the other way round
  });

  it("the threshold is the configured number of days", async () => {
    const { prisma, db } = stub([]);
    await new AccountJanitor(db, { inactiveDays: 30, now: () => NOW }).run();
    const where = (prisma.user.findMany.mock.calls[0][0] as { where: { OR: { lastLoginAt?: { lt: Date } }[] } }).where;
    expect(where.OR[0].lastLoginAt?.lt).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });
});

describe("AccountJanitor.start", () => {
  it("does not run at all when the rule is switched off (0 days)", () => {
    vi.useFakeTimers();
    const { prisma, db } = stub([]);
    const janitor = new AccountJanitor(db, { inactiveDays: 0 });
    janitor.start();
    vi.advanceTimersByTime(24 * 3600_000);
    janitor.stop();
    vi.useRealTimers();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("runs once at the start and then on the interval, and a failing run is logged, not thrown", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { prisma, db } = stub([]);
    prisma.user.findMany.mockRejectedValueOnce(new Error("database is gone")).mockResolvedValue([]);
    const janitor = new AccountJanitor(db, { inactiveDays: 7, intervalMs: 1000 });
    janitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    janitor.stop();
    vi.useRealTimers();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
  });
});
