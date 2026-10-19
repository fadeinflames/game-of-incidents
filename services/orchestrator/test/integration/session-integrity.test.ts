// Integration tests: real PostgreSQL (DATABASE_URL), fake runtime (no Docker). Skipped without DATABASE_URL.
// A session keeps the scenario it started with, only its owner can read it, the 7-day account rule, a moderator's approval.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, SessionStatus, SubmissionStatus } from "@wom/db";
import { upsertImportRecord } from "@wom/db/import";
import { FakeRuntimeProvider } from "@wom/runtime";
import type { ImportRecord } from "@wom/scenario";
import { AccountJanitor } from "../../src/accounts";
import { clearEndedRuntimeHandles } from "../../src/retention";
import { SessionService } from "../../src/sessions";

const hasDb = Boolean(process.env.DATABASE_URL);
const prisma = new PrismaClient();
const SLUG = "test-snap";
const USERS = ["integrity-a", "integrity-b", "integrity-idle-6d", "integrity-idle-8d", "integrity-never", "integrity-admin"];
const PASS = '{"passed":true,"criteria":[{"id":"x","ok":true,"message":"ok"}]}';
const DAY = 24 * 3600_000;

async function waitFor(pred: () => Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting");
}

describe.skipIf(!hasDb)("session integrity (integration)", () => {
  let owner: string;
  let stranger: string;
  let scenarioId: string;
  const opts = { maxSessionsPerUser: 1, maxSessionsGlobal: 10, breakTimeoutMs: 1000, graderTimeoutMs: 1000, defaultTtlMin: 45 };

  beforeAll(async () => {
    const [a, b] = await Promise.all(USERS.slice(0, 2).map((username) => prisma.user.upsert({ where: { username }, update: {}, create: { username, passwordHash: "x" } })));
    owner = a.id;
    stranger = b.id;
    const s = await prisma.scenario.upsert({
      where: { slug: SLUG },
      update: { isPublished: true },
      create: {
        slug: SLUG,
        title: "snap",
        summary: "s",
        type: "t",
        contextJson: {},
        eventsJson: [],
        hintsJson: [{ level: 1, penalty: 10, text: "old hint" }],
        actionsJson: [],
        environmentJson: { image: "img", ttlMin: 30 },
        isPublished: true, // removed in afterAll and unpublished by the global setup if a run crashed
        breakScript: "echo break",
        graderScript: "echo old-check",
      },
    });
    scenarioId = s.id;
  });

  afterAll(async () => {
    await prisma.trainingSession.deleteMany({ where: { user: { username: { in: USERS } } } });
    await prisma.scenarioSubmission.deleteMany({ where: { slug: { startsWith: "test-appr-" } } });
    await prisma.scenario.deleteMany({ where: { slug: { in: [SLUG, "test-appr-one", "test-appr-one-tutorial"] } } });
    await prisma.user.deleteMany({ where: { username: { in: USERS } } });
    await prisma.$disconnect();
  });

  it("a re-import while the session runs does not change its grader, its hints or the score", async () => {
    await prisma.trainingSession.deleteMany({ where: { userId: owner } });
    const runtime = new FakeRuntimeProvider();
    runtime.scriptResponder = (script) => ({ exitCode: 0, stdout: script.includes("check") ? PASS : "", stderr: "", timedOut: false });
    const svc = new SessionService(prisma, runtime, opts);
    const s = await svc.create(owner, scenarioId);
    await waitFor(async () => (await svc.get(s.id))?.status === SessionStatus.RUNNING);
    expect((await svc.get(s.id))!.scenarioSnapshot).toMatchObject({ v: 1, graderScript: "echo old-check" });

    await prisma.scenario.update({ where: { id: scenarioId }, data: { graderScript: "echo new-check", hintsJson: [{ level: 1, penalty: 0, text: "new hint" }] } });
    try {
      expect(await svc.useHint(s.id, 1)).toEqual({ text: "old hint", penalty: 10 });
      runtime.scripts.length = 0;
      const { session } = await svc.check(s.id);
      expect(runtime.scripts).toEqual(["echo old-check"]);
      expect(session.status).toBe(SessionStatus.FINISHED);
      expect(session.score).toBe(90);
    } finally {
      await prisma.scenario.update({ where: { id: scenarioId }, data: { graderScript: "echo old-check", hintsJson: [{ level: 1, penalty: 10, text: "old hint" }] } });
    }
    // the session is over and its sandbox is gone: the copy of the grader script is not kept with it
    await svc.settleDestroys(2000);
    await waitFor(async () => (await svc.get(s.id))!.scenarioSnapshot === null);
  });

  it("the retention sweep clears the snapshot of an ended session and leaves a running one alone", async () => {
    const snapshot = { v: 1, environment: null, hints: [], breakScript: null, graderScript: "echo secret" };
    const longAgo = new Date(Date.now() - 5 * DAY);
    const [ended, running] = await Promise.all([
      prisma.trainingSession.create({ data: { userId: stranger, scenarioId, status: SessionStatus.EXPIRED, finishedAt: longAgo, scenarioSnapshot: snapshot } }),
      prisma.trainingSession.create({ data: { userId: stranger, scenarioId, status: SessionStatus.RUNNING, createdAt: longAgo, scenarioSnapshot: snapshot } }),
    ]);
    expect(await clearEndedRuntimeHandles(prisma, 2, new Date(), { pauseMs: 0 })).toBeGreaterThanOrEqual(1);
    expect((await prisma.trainingSession.findUnique({ where: { id: ended.id } }))!.scenarioSnapshot).toBeNull();
    expect((await prisma.trainingSession.findUnique({ where: { id: running.id } }))!.scenarioSnapshot).not.toBeNull();
  });

  it("getOwned gives a session to its owner only", async () => {
    const row = await prisma.trainingSession.create({ data: { userId: owner, scenarioId, status: SessionStatus.FINISHED, finishedAt: new Date() } });
    const svc = new SessionService(prisma, new FakeRuntimeProvider(), opts);
    expect((await svc.getOwned(row.id, owner))?.id).toBe(row.id);
    expect(await svc.getOwned(row.id, stranger)).toBeNull();
    expect(await svc.getOwned("no-such-session", owner)).toBeNull();
  });

  it("accounts idle for more than 7 days are disabled with their browser sessions, 6 days idle and admins are not", async () => {
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const mk = (username: string, data: { lastLoginAt: Date | null; createdAt?: Date; role?: string }) =>
      prisma.user.upsert({ where: { username }, update: { disabledAt: null, ...data }, create: { username, passwordHash: "x", ...data } });
    const [six, eight, never, admin] = await Promise.all([
      mk("integrity-idle-6d", { lastLoginAt: at(6) }),
      mk("integrity-idle-8d", { lastLoginAt: at(8) }),
      mk("integrity-never", { lastLoginAt: null, createdAt: at(9) }),
      mk("integrity-admin", { lastLoginAt: at(30), role: "admin" }),
    ]);
    await prisma.session.create({ data: { tokenHash: `integrity-${now.getTime()}`, expiresAt: new Date(now.getTime() + DAY), userId: eight.id } });

    await new AccountJanitor(prisma, { inactiveDays: 7, now: () => now }).run();

    const disabled = async (id: string) => (await prisma.user.findUnique({ where: { id } }))!.disabledAt;
    expect(await disabled(six.id)).toBeNull();
    expect(await disabled(admin.id)).toBeNull();
    expect(await disabled(eight.id)).not.toBeNull();
    expect(await disabled(never.id)).not.toBeNull(); // never logged in: counted from the registration
    expect(await prisma.session.count({ where: { userId: eight.id } })).toBe(0);
  });

  it("a moderator's approval publishes the submission as a scenario of its author, and an approval repeated updates it", async () => {
    const record = (title: string): ImportRecord =>
      ({
        slug: "test-appr-one",
        schemaVersion: 2,
        title,
        summary: "A short summary of the case.",
        type: "linux",
        difficulty: "MIDDLE",
        durationMin: 20,
        tags: [],
        contextJson: {},
        eventsJson: [],
        hintsJson: [],
        actionsJson: [],
        gmScriptJson: null,
        briefMd: null,
        debriefMd: null,
        guideMd: "## Шаг 1\n\nПосмотри на логи.\n",
        environmentJson: null,
        breakScript: null,
        graderScript: null,
        solutionScript: null,
      }) as ImportRecord;
    const sub = await prisma.scenarioSubmission.create({
      data: { authorId: owner, slug: "test-appr-one", title: "one", status: SubmissionStatus.PASSED, archive: Buffer.from("zip"), record: record("First") as never },
    });
    const first = await upsertImportRecord(prisma, record("First"), { authorId: owner, isPublished: true });
    await prisma.scenarioSubmission.update({ where: { id: sub.id }, data: { status: SubmissionStatus.APPROVED, scenarioId: first.id } });
    const second = await upsertImportRecord(prisma, record("Second"), { authorId: owner, isPublished: true });

    expect(second.id).toBe(first.id); // the same row, not a duplicate of the slug
    expect(second).toMatchObject({ title: "Second", authorId: owner, isPublished: true, source: null });
    // a record with a guide also makes the teaching copy
    const tutorial = await prisma.scenario.findUnique({ where: { slug: "test-appr-one-tutorial" } });
    expect(tutorial).toMatchObject({ authorId: owner, isPublished: true });
    expect((await prisma.scenarioSubmission.findUnique({ where: { id: sub.id } }))!.scenarioId).toBe(first.id);
  });
});
