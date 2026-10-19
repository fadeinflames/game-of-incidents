import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  createSession: vi.fn(),
  loginUser: vi.fn(),
  registerUser: vi.fn(),
}));
vi.mock("@/lib/auth", () => auth);
vi.mock("@wom/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { prisma: {}, Prisma: { PrismaClientKnownRequestError } };
});

import { Prisma } from "@wom/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { freshIp, jsonRequest } from "./helpers";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.REGISTRATION_ENABLED;
  delete process.env.REGISTRATIONS_PER_IP_PER_DAY;
});

const credentials = (identity: string) => ({ identity, password: "correct-horse" });

describe("POST /api/auth/login", () => {
  it("answers a wrong password with a Russian 401 and does not open a session", async () => {
    auth.loginUser.mockResolvedValue(null);
    const res = await login(jsonRequest("/api/auth/login", credentials("alice-wrong")));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Неверный логин или пароль");
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("logs a digest of the failed login, never the typed string", async () => {
    auth.loginUser.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn");
    warn.mockClear();
    await login(jsonRequest("/api/auth/login", credentials("my-actual-password-oops")));
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("login_failed");
    expect(line).not.toContain("my-actual-password-oops");
    expect(JSON.parse(line).identity_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("tells a disabled account about it with 403", async () => {
    auth.loginUser.mockResolvedValue({ disabled: true });
    const res = await login(jsonRequest("/api/auth/login", credentials("alice-disabled")));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("отключена");
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("does not send a disabled account to an administrator it cannot reach when CONTACT_URL is empty", async () => {
    auth.loginUser.mockResolvedValue({ disabled: true });
    delete process.env.CONTACT_URL;
    const without = (await (await login(jsonRequest("/api/auth/login", credentials("alice-nocontact")))).json()).error;
    expect(without).toContain("пока не настроен");
    expect(without).not.toContain("Напиши администратору");
    process.env.CONTACT_URL = "https://t.me/example";
    try {
      const withUrl = (await (await login(jsonRequest("/api/auth/login", credentials("alice-contact")))).json()).error;
      expect(withUrl).toContain("Напиши администратору");
    } finally {
      delete process.env.CONTACT_URL;
    }
  });

  it("limits guessing per login even when every attempt comes from another address", async () => {
    auth.loginUser.mockResolvedValue(null);
    for (let i = 0; i < 10; i++) {
      expect((await login(jsonRequest("/api/auth/login", credentials("victim")))).status).toBe(401);
    }
    const res = await login(jsonRequest("/api/auth/login", credentials("victim")));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect((await res.json()).error).toContain("с этим логином");
    expect(auth.loginUser).toHaveBeenCalledTimes(10);
  });

  it("does not count successful logins towards the per-login limit", async () => {
    auth.loginUser.mockResolvedValue({ id: "u1" });
    for (let i = 0; i < 15; i++) {
      const res = await login(jsonRequest("/api/auth/login", credentials("alice-ok")));
      expect(res.status).toBe(200);
    }
    expect(auth.createSession).toHaveBeenCalledTimes(15);
  });

  it("refuses a request from another origin before looking at the body", async () => {
    const res = await login(jsonRequest("/api/auth/login", credentials("alice-csrf"), { origin: "https://evil.test", host: "web.test" }));
    expect(res.status).toBe(403);
    expect(auth.loginUser).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload with 400", async () => {
    const res = await login(jsonRequest("/api/auth/login", { identity: "a" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/register", () => {
  const body = (username: string) => ({ username, password: "Tr1cky-Passphrase" });

  it("creates an account and a browser session", async () => {
    auth.registerUser.mockResolvedValue({ id: "u1" });
    const res = await register(jsonRequest("/api/auth/register", body("newbie")));
    expect(res.status).toBe(200);
    expect(auth.createSession).toHaveBeenCalledWith("u1");
  });

  it("answers a closed registration with 403", async () => {
    process.env.REGISTRATION_ENABLED = "false";
    const res = await register(jsonRequest("/api/auth/register", body("newbie")));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Регистрация закрыта");
    expect(auth.registerUser).not.toHaveBeenCalled();
  });

  it("caps accounts created from one public address per day", async () => {
    process.env.REGISTRATIONS_PER_IP_PER_DAY = "2";
    auth.registerUser.mockResolvedValue({ id: "u1" });
    const ip = freshIp();
    const attempt = () => register(jsonRequest("/api/auth/register", body("daily"), { "x-forwarded-for": ip }));
    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(200);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("слишком много учётных записей");
    expect(auth.registerUser).toHaveBeenCalledTimes(2);
  });

  it("gives the day token back when the name is taken, so failures do not eat the cap", async () => {
    process.env.REGISTRATIONS_PER_IP_PER_DAY = "1";
    const ip = freshIp();
    const attempt = () => register(jsonRequest("/api/auth/register", body("taken"), { "x-forwarded-for": ip }));
    const duplicate = new (Prisma.PrismaClientKnownRequestError as unknown as new (m: string, c: string) => Error)("dup", "P2002");
    auth.registerUser.mockRejectedValueOnce(duplicate);
    const taken = await attempt();
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe("Такое имя пользователя уже занято");
    auth.registerUser.mockResolvedValue({ id: "u2" });
    expect((await attempt()).status).toBe(200);
  });

  it("applies no daily cap to an internal address that identifies nobody", async () => {
    process.env.REGISTRATIONS_PER_IP_PER_DAY = "1";
    auth.registerUser.mockResolvedValue({ id: "u1" });
    // the per-minute limiter is per address too, so stay below it
    for (let i = 0; i < 3; i++) {
      const res = await register(jsonRequest("/api/auth/register", body("proxy"), { "x-forwarded-for": "172.18.0.1" }));
      expect(res.status).toBe(200);
    }
  });
});
