// Retention jobs against a stub of $executeRaw: batches, cutoffs, the statements, and a step that fails not stopping the others.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@wom/db";
import { logger } from "../../src/logger";
import { clearEndedRuntimeHandles, inBatches, purgeSessionEvents, purgeSubmissionArchives, runRetention } from "../../src/retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-03T12:00:00Z");

type Call = { sql: string; values: unknown[] };

/** $executeRaw as a tagged template: the stub records the statement and the values and answers from `counts` in order */
function stub(counts: number[] | ((sql: string) => number)) {
  const calls: Call[] = [];
  let i = 0;
  const $executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ sql, values });
    return typeof counts === "function" ? counts(sql) : (counts[i++] ?? 0);
  });
  return { prisma: { $executeRaw } as unknown as PrismaClient, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("inBatches", () => {
  it("goes on while a batch comes back full and stops at the first short one", async () => {
    const answers = [100, 100, 40, 100];
    const step = vi.fn(async () => answers.shift()!);
    expect(await inBatches(step, 100, { pauseMs: 0 })).toBe(240);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("stops at the cap even when there is more, so one run cannot go on for hours", async () => {
    const step = vi.fn(async () => 100);
    expect(await inBatches(step, 100, { maxBatches: 5, pauseMs: 0 })).toBe(500);
    expect(step).toHaveBeenCalledTimes(5);
  });
});

describe("purgeSessionEvents", () => {
  it("deletes events older than the limit, one batch at a time", async () => {
    const { prisma, calls } = stub([3, 3, 1]);
    expect(await purgeSessionEvents(prisma, 90, NOW, { batchSize: 3, pauseMs: 0 })).toBe(7);
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toContain('DELETE FROM "SessionEvent"');
    expect(calls[0].sql).toContain("LIMIT");
    expect(calls[0].values).toEqual([new Date(NOW.getTime() - 90 * DAY), 3]);
  });

  it("0 days = keep forever: not a statement is sent", async () => {
    const { prisma, calls } = stub([5]);
    expect(await purgeSessionEvents(prisma, 0, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("purgeSubmissionArchives", () => {
  it("empties archives of decided submissions (published, rejected, lint failed) and leaves the open ones", async () => {
    const { prisma, calls } = stub([2]);
    expect(await purgeSubmissionArchives(prisma, 180, NOW, { pauseMs: 0 })).toBe(2);
    expect(calls[0].sql).toContain(`'APPROVED', 'REJECTED', 'LINT_FAILED'`);
    expect(calls[0].sql).not.toMatch(/'(UPLOADED|TESTING|PASSED|FAILED)'/);
    expect(calls[0].sql).toContain("octet_length");
    expect(calls[0].values[0]).toEqual(new Date(NOW.getTime() - 180 * DAY));
  });

  it("works in batches: a table with more rows than one batch is emptied over several statements", async () => {
    const { prisma, calls } = stub([50, 50, 7]);
    expect(await purgeSubmissionArchives(prisma, 180, NOW, { batchSize: 50, pauseMs: 0 })).toBe(107);
    expect(calls).toHaveLength(3);
  });

  it("0 days = keep forever", async () => {
    const { prisma, calls } = stub([5]);
    expect(await purgeSubmissionArchives(prisma, 0, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("clearEndedRuntimeHandles", () => {
  it("clears the handle only of sessions that ended, so a running stand is never cut off from its row", async () => {
    const { prisma, calls } = stub([1]);
    await clearEndedRuntimeHandles(prisma, 2, NOW, { pauseMs: 0 });
    expect(calls[0].sql).toContain('"runtimeHandle" = NULL');
    expect(calls[0].sql).toContain('"scenarioSnapshot" = NULL'); // the grader script copy goes with the handle
    expect(calls[0].sql).toContain(`NOT IN ('REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'CHECKING')`);
    expect(calls[0].values[0]).toEqual(new Date(NOW.getTime() - 2 * DAY));
  });
});

describe("runRetention", () => {
  it("runs every step, reports the numbers, and a failing step does not stop the others", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { prisma } = stub((sql) => {
      if (sql.includes('"SessionEvent"')) throw new Error("deadlock detected");
      return sql.includes('"ScenarioSubmission"') ? 4 : 9;
    });
    expect(await runRetention(prisma, { events: 90, archives: 180 }, NOW, { pauseMs: 0 })).toEqual({ events: 0, archives: 4, handles: 9 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ step: "events", err: "deadlock detected" }), expect.any(String));
  });

  it("logs what it did", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { prisma } = stub(() => 0);
    await runRetention(prisma, { events: 90, archives: 180 }, NOW, { pauseMs: 0 });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ events: 0, archives: 0, handles: 0, eventsKeepDays: 90, archivesKeepDays: 180 }), "retention run finished");
  });
});
