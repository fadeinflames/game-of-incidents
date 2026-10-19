import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), requireUser: vi.fn() }));
const orch = vi.hoisted(() => ({ orchestrator: vi.fn() }));
const db = vi.hoisted(() => ({
  prisma: {
    scenario: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    scenarioSubmission: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
  SubmissionStatus: { UPLOADED: "UPLOADED", TESTING: "TESTING", PASSED: "PASSED", FAILED: "FAILED", APPROVED: "APPROVED", REJECTED: "REJECTED" },
}));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/orchestrator", () => ({ ORCH_TIMEOUT: {}, orchestrator: orch.orchestrator }));
vi.mock("@wom/db", () => db);
vi.mock("@wom/db/import", () => ({ upsertImportRecord: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { POST as scenarioAction } from "@/app/api/admin/scenarios/[id]/[action]/route";
import { POST as submissionAction } from "@/app/api/admin/submissions/[id]/[action]/route";
import { jsonRequest } from "./helpers";

const ctx = (params: { id: string; action: string }) => ({ params: Promise.resolve(params) });
const trail = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("admin_action")).map((l) => JSON.parse(l) as Record<string, string>);

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  auth.getCurrentUser.mockResolvedValue({ id: "admin1", username: "root", email: null, role: "admin" });
});

describe("admin trail: scenarios and moderation", () => {
  it("records publish and unpublish of a scenario", async () => {
    db.prisma.scenario.findUnique.mockResolvedValue({ id: "sc1", slug: "disk-full" });
    db.prisma.scenario.updateMany.mockResolvedValue({ count: 2 });
    await scenarioAction(jsonRequest("/x", {}), ctx({ id: "sc1", action: "publish" }));
    await scenarioAction(jsonRequest("/x", {}), ctx({ id: "sc1", action: "unpublish" }));
    expect(trail(log).map((l) => [l.actor, l.action, l.target])).toEqual([
      ["admin1", "publish", "scenario:sc1"],
      ["admin1", "unpublish", "scenario:sc1"],
    ]);
  });

  it("records a rejection with the submission id but not the moderator note", async () => {
    db.prisma.scenarioSubmission.findUnique.mockResolvedValue({ id: "sub1", slug: "x", status: "FAILED", authorId: "a1" });
    db.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db.prisma));
    db.prisma.scenarioSubmission.update.mockResolvedValue({ id: "sub1", status: "REJECTED" });
    const res = await submissionAction(jsonRequest("/x", { note: "confidential-note" }), ctx({ id: "sub1", action: "reject" }));
    expect(res.status).toBe(200);
    expect(trail(log)).toEqual([expect.objectContaining({ actor: "admin1", action: "reject", target: "submission:sub1" })]);
    expect(log.mock.calls.map((c) => String(c[0])).join("")).not.toContain("confidential-note");
  });

  it("writes nothing when the submission action is refused", async () => {
    db.prisma.scenarioSubmission.findUnique.mockResolvedValue({ id: "sub1", slug: "x", status: "UPLOADED", authorId: "a1" });
    const res = await submissionAction(jsonRequest("/x", {}), ctx({ id: "sub1", action: "approve" }));
    expect(res.status).toBe(400);
    expect(trail(log)).toEqual([]);
  });
});
