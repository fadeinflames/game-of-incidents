// Retention: what the platform keeps and for how long. The tables below only grow otherwise (every session writes a few
// events, every upload is up to 5 MB inside the database and inside every nightly dump). Everything runs in small batches
// so a purge never holds a long lock on a table the players are using, and every run is logged with its numbers.
import type { PrismaClient } from "@wom/db";
import { logger } from "./logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/** rows per statement: events are tiny, an archive row carries up to 5 MB of bytea */
export const EVENT_BATCH = 5000;
export const ARCHIVE_BATCH = 50;
export const HANDLE_BATCH = 500;
/** one run does at most this many batches per table; whatever is left goes in the next daily run */
const MAX_BATCHES = 200;
/** a pause between two batches, so the purge shares the database with the players */
const BATCH_PAUSE_MS = 100;
/** the handle of an ended session (for a kubernetes one it holds the cluster's admin kubeconfig) is cleared when its sandbox was destroyed; this sweeps the ones that missed it */
export const HANDLE_KEEP_DAYS = 2;

export type RetentionDays = {
  /** SessionEvent rows older than this are deleted (0 = keep forever) */
  events: number;
  /** archives (the uploaded zip) of decided submissions older than this are emptied (0 = keep forever) */
  archives: number;
};

export type RetentionReport = { events: number; archives: number; handles: number };

/** Runs `step(limit)` until a batch comes back short (nothing left) or the cap is reached; returns the total. */
export async function inBatches(step: (limit: number) => Promise<number>, batchSize: number, opts: { maxBatches?: number; pauseMs?: number } = {}): Promise<number> {
  const maxBatches = opts.maxBatches ?? MAX_BATCHES;
  const pauseMs = opts.pauseMs ?? BATCH_PAUSE_MS;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await step(batchSize);
    total += n;
    if (n < batchSize) break;
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return total;
}

const cutoffOf = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** the session timeline older than `days`; the sessions themselves (scores, results) stay */
export async function purgeSessionEvents(prisma: PrismaClient, days: number, now: Date = new Date(), opts: { batchSize?: number; pauseMs?: number } = {}): Promise<number> {
  if (!(days > 0)) return 0;
  const cutoff = cutoffOf(now, days);
  return inBatches(
    (limit) => prisma.$executeRaw`DELETE FROM "SessionEvent" WHERE "id" IN (SELECT "id" FROM "SessionEvent" WHERE "createdAt" < ${cutoff} LIMIT ${limit})`,
    opts.batchSize ?? EVENT_BATCH,
    opts,
  );
}

/**
 * The archive of a decided submission (published, rejected, or never passed the lint) is kept for a while for the
 * moderator and then emptied; the record, the reports and the moderator's note stay. An emptied archive is a zero-length
 * one: whoever serves the download must answer "gone" for it, not an empty zip. Raw SQL because Prisma cannot filter by
 * the length of a Bytes column, and because the row's updatedAt (the age of the decision) must not move.
 */
export async function purgeSubmissionArchives(prisma: PrismaClient, olderThanDays: number, now: Date = new Date(), opts: { batchSize?: number; pauseMs?: number } = {}): Promise<number> {
  if (!(olderThanDays > 0)) return 0;
  const cutoff = cutoffOf(now, olderThanDays);
  return inBatches(
    (limit) => prisma.$executeRaw`
      UPDATE "ScenarioSubmission" SET "archive" = ''::bytea
      WHERE "id" IN (
        SELECT "id" FROM "ScenarioSubmission"
        WHERE "status" IN ('APPROVED', 'REJECTED', 'LINT_FAILED') AND "updatedAt" < ${cutoff} AND octet_length("archive") > 0
        LIMIT ${limit})`,
    opts.batchSize ?? ARCHIVE_BATCH,
    opts,
  );
}

/**
 * the runtime handle of sessions that ended long ago: a kubeconfig that opens a dead cluster is no use to anyone and should not sit in every dump.
 * The scenario snapshot (it carries the grader script) goes with it: nothing reads it once the session has ended.
 */
export async function clearEndedRuntimeHandles(prisma: PrismaClient, olderThanDays: number = HANDLE_KEEP_DAYS, now: Date = new Date(), opts: { batchSize?: number; pauseMs?: number } = {}): Promise<number> {
  const cutoff = cutoffOf(now, olderThanDays);
  return inBatches(
    (limit) => prisma.$executeRaw`
      UPDATE "TrainingSession" SET "runtimeHandle" = NULL, "scenarioSnapshot" = NULL
      WHERE "id" IN (
        SELECT "id" FROM "TrainingSession"
        WHERE "status" NOT IN ('REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'CHECKING')
          AND (("runtimeHandle" IS NOT NULL AND jsonb_typeof("runtimeHandle") <> 'null') OR "scenarioSnapshot" IS NOT NULL)
          AND COALESCE("finishedAt", "createdAt") < ${cutoff}
        LIMIT ${limit})`,
    opts.batchSize ?? HANDLE_BATCH,
    opts,
  );
}

/** one retention run; a failing step is logged and does not stop the others */
export async function runRetention(prisma: PrismaClient, days: RetentionDays, now: Date = new Date(), opts: { pauseMs?: number } = {}): Promise<RetentionReport> {
  const report: RetentionReport = { events: 0, archives: 0, handles: 0 };
  const steps: [keyof RetentionReport, () => Promise<number>][] = [
    ["events", () => purgeSessionEvents(prisma, days.events, now, opts)],
    ["archives", () => purgeSubmissionArchives(prisma, days.archives, now, opts)],
    ["handles", () => clearEndedRuntimeHandles(prisma, HANDLE_KEEP_DAYS, now, opts)],
  ];
  for (const [name, step] of steps) {
    try {
      report[name] = await step();
    } catch (err) {
      logger.warn({ step: name, err: err instanceof Error ? err.message : String(err) }, "retention step failed");
    }
  }
  logger.info({ ...report, eventsKeepDays: days.events, archivesKeepDays: days.archives }, "retention run finished");
  return report;
}

/** what `docker system df` says, in bytes: the size of the images and of the build cache is what fills the sandbox disk over weeks */
export type DockerUsage = { imagesBytes: number; imageCount: number; submissionImages: number; submissionImagesBytes: number; buildCacheBytes: number };

/** Daily: the retention run and, if the runtime can say it, the size of the sandbox daemon's images and build cache. Returns the stop function. */
export function startRetention(
  prisma: PrismaClient,
  days: RetentionDays,
  opts: { dockerUsage?: () => Promise<DockerUsage>; everyMs?: number; firstRunInMs?: number } = {},
): () => void {
  const run = async () => {
    await runRetention(prisma, days).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "retention run failed"));
    if (!opts.dockerUsage) return;
    try {
      logger.info({ ...(await opts.dockerUsage()) }, "sandbox daemon disk usage");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox daemon disk usage could not be read");
    }
  };
  // not at the very start: the process has recovery work to do first
  const first = setTimeout(() => void run(), opts.firstRunInMs ?? 60_000);
  first.unref();
  const timer = setInterval(() => void run(), opts.everyMs ?? DAY_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
