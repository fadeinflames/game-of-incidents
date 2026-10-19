import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), requireUser: vi.fn() }));
const orch = vi.hoisted(() => ({ orchestrator: vi.fn() }));
const db = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    trainingSession: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/orchestrator", () => ({ ORCH_TIMEOUT: { create: 1, kill: 2 }, orchestrator: orch.orchestrator }));
vi.mock("@wom/db", () => db);
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { POST as userAction } from "@/app/api/admin/users/[id]/[action]/route";
import { POST as killOne } from "@/app/api/admin/sessions/[id]/kill/route";
import { POST as killAll } from "@/app/api/admin/sessions/kill-all/route";
import { jsonRequest } from "./helpers";

const admin = { id: "admin1", username: "root", email: null, role: "admin" };
const plain = { id: "u1", username: "alice", email: null, role: "user" };
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const post = (headers: Record<string, string> = {}) => jsonRequest("/api/admin/x", {}, headers);

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "user action": (req) => userAction(req, ctx({ id: "u2", action: "disable" })),
  "kill one session": (req) => killOne(req, ctx({ id: "s1" })),
  "kill all sessions": (req) => killAll(req),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {}); // the admin trail goes to stdout
  auth.getCurrentUser.mockResolvedValue(admin);
});

describe.each(Object.entries(routes))("admin route: %s", (_name, call) => {
  it("answers 403 to a plain user and touches nothing", async () => {
    auth.getCurrentUser.mockResolvedValue(plain);
    const res = await call(post());
    expect(res.status).toBe(403);
    expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(db.prisma.trainingSession.findMany).not.toHaveBeenCalled();
    expect(orch.orchestrator).not.toHaveBeenCalled();
  });

  it("answers 401 when nobody is logged in", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect((await call(post())).status).toBe(401);
    expect(orch.orchestrator).not.toHaveBeenCalled();
  });

  it("answers 403 to a request from another origin even with an admin cookie", async () => {
    const res = await call(post({ origin: "https://evil.test", host: "web.test" }));
    expect(res.status).toBe(403);
    expect(auth.getCurrentUser).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/users/[id]/[action]", () => {
  it("does not let an admin disable themselves", async () => {
    db.prisma.user.findUnique.mockResolvedValue({ id: "admin1", username: "root", role: "admin", disabledAt: null });
    const res = await userAction(post(), ctx({ id: "admin1", action: "disable" }));
    expect(res.status).toBe(400);
    expect(db.prisma.user.update).not.toHaveBeenCalled();
  });

  it("disables another account and ends its browser sessions", async () => {
    db.prisma.user.findUnique.mockResolvedValue({ id: "u2", username: "bob", role: "user", disabledAt: null });
    db.prisma.trainingSession.findMany.mockResolvedValue([]);
    const res = await userAction(post(), ctx({ id: "u2", action: "disable" }));
    expect(res.status).toBe(200);
    expect(db.prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u2" } });
    expect(orch.orchestrator).not.toHaveBeenCalled();
  });

  it("stops the active stands of the disabled account through the orchestrator", async () => {
    db.prisma.user.findUnique.mockResolvedValue({ id: "u2", username: "bob", role: "user", disabledAt: null });
    db.prisma.trainingSession.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    orch.orchestrator.mockResolvedValue({ status: 200, body: {} });
    const res = await userAction(post(), ctx({ id: "u2", action: "disable" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, stopped: 2, stopFailed: 0 });
    expect(body.warning).toBeUndefined();
    expect(db.prisma.trainingSession.findMany.mock.calls[0][0].where.userId).toBe("u2");
    expect(orch.orchestrator.mock.calls.map((c) => c[0]).sort()).toEqual(["/admin/sessions/s1", "/admin/sessions/s2"]);
    expect(orch.orchestrator.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });

  it("still disables the account when a stand cannot be stopped, and says so in the answer", async () => {
    db.prisma.user.findUnique.mockResolvedValue({ id: "u2", username: "bob", role: "user", disabledAt: null });
    db.prisma.trainingSession.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    orch.orchestrator.mockImplementation(async (path: string) => (path.endsWith("/s1") ? { status: 503, body: {} } : { status: 200, body: {} }));
    const res = await userAction(post(), ctx({ id: "u2", action: "disable" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(db.prisma.user.update).toHaveBeenCalledWith({ where: { id: "u2" }, data: { disabledAt: expect.any(Date) } });
    expect(body).toMatchObject({ ok: true, stopped: 1, stopFailed: 1 });
    expect(body.warning).toContain("остановить не удалось");
  });

  it("still disables the account when the list of its stands cannot be read", async () => {
    db.prisma.user.findUnique.mockResolvedValue({ id: "u2", username: "bob", role: "user", disabledAt: null });
    db.prisma.trainingSession.findMany.mockRejectedValue(new Error("db down"));
    const res = await userAction(post(), ctx({ id: "u2", action: "disable" }));
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toBeDefined();
  });

  it("answers 404 for an unknown user and 400 for an unknown action", async () => {
    db.prisma.user.findUnique.mockResolvedValueOnce(null);
    expect((await userAction(post(), ctx({ id: "nope", action: "disable" }))).status).toBe(404);
    db.prisma.user.findUnique.mockResolvedValueOnce({ id: "u2", username: "bob", role: "user", disabledAt: null });
    expect((await userAction(post(), ctx({ id: "u2", action: "explode" }))).status).toBe(400);
  });
});

describe("POST /api/admin/sessions/kill-all", () => {
  it("kills every active session through the orchestrator and reports the count", async () => {
    db.prisma.trainingSession.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    orch.orchestrator.mockResolvedValue({ status: 200, body: {} });
    const res = await killAll(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ killed: 4, failed: 0 });
    expect(orch.orchestrator.mock.calls.map((c) => c[0]).sort()).toEqual(["/admin/sessions/a", "/admin/sessions/b", "/admin/sessions/c", "/admin/sessions/d"]);
  });

  it("answers 503 when the orchestrator accepted nothing", async () => {
    db.prisma.trainingSession.findMany.mockResolvedValue([{ id: "a" }]);
    orch.orchestrator.mockResolvedValue({ status: 503, body: {} });
    const res = await killAll(post());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Попробуй");
  });

  it("is a no-op with no active sessions", async () => {
    db.prisma.trainingSession.findMany.mockResolvedValue([]);
    const res = await killAll(post());
    expect(await res.json()).toEqual({ killed: 0, failed: 0 });
    expect(orch.orchestrator).not.toHaveBeenCalled();
  });
});

describe("admin action trail on stdout", () => {
  const lines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("admin_action")).map((l) => JSON.parse(l) as Record<string, string>);
  const bob = { id: "u2", username: "bob", role: "user", disabledAt: null };

  it("writes one JSON line per user action with actor, action, target and time", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    db.prisma.user.findUnique.mockResolvedValue(bob);
    db.prisma.trainingSession.findMany.mockResolvedValue([]);
    for (const action of ["disable", "enable", "make-admin", "make-user"]) {
      expect((await userAction(post(), ctx({ id: "u2", action }))).status).toBe(200);
    }
    const written = lines(log);
    expect(written.map((l) => l.action)).toEqual(["disable", "enable", "make-admin", "make-user"]);
    for (const l of written) {
      expect(Object.keys(l).sort()).toEqual(["action", "actor", "at", "event", "target"]);
      expect(l).toMatchObject({ event: "admin_action", actor: "admin1", target: "user:u2" });
      expect(Number.isNaN(Date.parse(l.at))).toBe(false);
    }
    log.mockRestore();
  });

  it("never puts the reset password into the trail", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    db.prisma.user.findUnique.mockResolvedValue(bob);
    const res = await userAction(post(), ctx({ id: "u2", action: "reset-password" }));
    const { password } = await res.json();
    expect(password).toBeTruthy();
    expect(lines(log)).toHaveLength(1);
    expect(log.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain(password);
    log.mockRestore();
  });

  it("writes nothing for a refused or failed action", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    db.prisma.user.findUnique.mockResolvedValue({ ...bob, id: "admin1" });
    expect((await userAction(post(), ctx({ id: "admin1", action: "disable" }))).status).toBe(400);
    auth.getCurrentUser.mockResolvedValue(plain);
    expect((await userAction(post(), ctx({ id: "u2", action: "disable" }))).status).toBe(403);
    expect(lines(log)).toEqual([]);
    log.mockRestore();
  });

  it("records a single kill and a kill-all", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    orch.orchestrator.mockResolvedValue({ status: 200, body: {} });
    db.prisma.trainingSession.findMany.mockResolvedValue([{ id: "a" }]);
    await killOne(post(), ctx({ id: "s1" }));
    await killAll(post());
    expect(lines(log).map((l) => [l.action, l.target])).toEqual([["kill", "session:s1"], ["kill-all", "sessions:all"]]);
    log.mockRestore();
  });

  it("writes nothing when the orchestrator refuses the kill", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    orch.orchestrator.mockResolvedValue({ status: 503, body: { error: "down" } });
    db.prisma.trainingSession.findMany.mockResolvedValue([{ id: "a" }]);
    expect((await killOne(post(), ctx({ id: "s1" }))).status).toBe(503);
    expect((await killAll(post())).status).toBe(503);
    expect(lines(log)).toEqual([]);
    log.mockRestore();
  });
});
