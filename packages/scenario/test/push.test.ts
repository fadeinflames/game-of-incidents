import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArchiveError, extractScenarioZip } from "../src/archive";
import { loadScenarioFolder } from "../src/load";
import { PushError, packScenarioDir, pushScenario } from "../src/push";
import { cleanupFixtures, scenarioDir } from "./fixture";

afterEach(() => cleanupFixtures());

describe("packScenarioDir", () => {
  it("packs a folder so that the platform extractor and loader read it back", () => {
    const dir = scenarioDir();
    const zip = packScenarioDir(dir);
    const out = mkdtempSync(path.join(os.tmpdir(), "wom-push-test-"));
    try {
      const extracted = extractScenarioZip(zip, out);
      expect(loadScenarioFolder(extracted.dir).meta.slug).toBe("demo-case");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("leaves out VCS metadata, node_modules and Finder files", () => {
    const dir = scenarioDir({ files: { ".git/config": "x", "node_modules/a/index.js": "x", ".DS_Store": "x", "._brief.md": "x" } });
    const out = mkdtempSync(path.join(os.tmpdir(), "wom-push-test-"));
    try {
      const extracted = extractScenarioZip(packScenarioDir(dir), out);
      expect(extracted.files).toBe(7);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses a folder without scenario.yaml", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wom-push-empty-"));
    try {
      expect(() => packScenarioDir(dir)).toThrow(ArchiveError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file over the per-file limit", () => {
    const dir = scenarioDir({ files: { "image/big.bin": "x".repeat(2 * 1024 * 1024 + 1) } });
    expect(() => packScenarioDir(dir)).toThrow(/МБ/);
  });

  it("refuses a symbolic link", () => {
    const dir = scenarioDir();
    try {
      symlinkSync("/etc/passwd", path.join(dir, "link"));
    } catch {
      return; // the platform does not allow symlinks here (Windows without privileges): nothing to check
    }
    expect(() => packScenarioDir(dir)).toThrow(/символическ/);
  });
});

/** a tiny platform: the endpoints the push flow uses, with a switchable role and outcome */
type Fake = {
  admin: boolean;
  lint: "ok" | "fail";
  regress: "pass" | "fail";
  sessionFails: boolean;
  calls: string[];
  status: string;
  cookies: string[];
  upload: "json" | "html" | "redirect";
  testStatus: number | null;
  sessionHttp: number;
  sessionState: string;
  hang: boolean;
};
const fake: Fake = { admin: true, lint: "ok", regress: "pass", sessionFails: false, calls: [], status: "", cookies: [], upload: "json", testStatus: null, sessionHttp: 200, sessionState: "RUNNING", hang: false };

let server: http.Server;
let base = "";

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    // what the web app does against cross-site posts: the Origin host must be the Host of the request
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (!origin || new URL(String(origin)).host !== req.headers.host) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Запрос с другого origin" }));
      }
    }
    fake.calls.push(`${req.method} ${url}`);
    fake.cookies.push(String(req.headers.cookie ?? ""));
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    };
    if (url === "/api/auth/login") {
      const creds = JSON.parse(body.toString());
      if (creds.password !== "right") return send(401, { error: "Неверный логин или пароль" });
      return send(200, { ok: true }, { "set-cookie": "wom_session=abc; Path=/; HttpOnly" });
    }
    if (!String(req.headers.cookie ?? "").includes("wom_session=abc")) return send(401, { error: "Нужен вход" });
    if (url === "/api/author/submissions" && req.method === "POST") {
      if (fake.upload === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html>maintenance</html>");
      }
      if (fake.upload === "redirect") {
        res.writeHead(302, { location: "https://elsewhere.example.com/" });
        return res.end();
      }
      fake.status = fake.lint === "fail" ? "LINT_FAILED" : "UPLOADED";
      return send(201, { id: "sub1", slug: "demo-case", status: fake.status, lintReport: fake.lint === "fail" ? [{ level: "error", rule: "image-base", message: "базовый образ не из списка" }] : [] });
    }
    if (url === "/api/author/submissions" && req.method === "GET") {
      return send(200, { items: [{ id: "sub1", slug: "demo-case", status: fake.status, testReport: fake.status === "FAILED" ? { ok: false } : null, scenarioId: fake.status === "APPROVED" ? "scn1" : null }] });
    }
    if (url === "/api/admin/submissions/sub1/test") {
      if (fake.testStatus) return send(fake.testStatus, { error: "по сценарию теста" });
      if (!fake.admin) return send(403, { error: "Только для администратора" });
      fake.status = fake.regress === "pass" ? "PASSED" : "FAILED";
      return send(202, { queued: true });
    }
    if (url === "/api/admin/submissions/sub1/approve") {
      fake.status = "APPROVED";
      return send(200, { id: "sub1", status: "APPROVED", scenarioId: "scn1" });
    }
    if (url === "/api/sessions" && req.method === "POST") {
      if (JSON.parse(body.toString()).scenarioId !== "scn1") return send(400, { error: "Не указан сценарий" });
      return send(201, { id: "ses1", status: "REQUESTED" });
    }
    if (url === "/api/sessions/ses1") {
      if (fake.hang) return; // never answers
      if (fake.sessionHttp >= 400) return send(fake.sessionHttp, { error: "недоступна" });
      return send(200, { id: "ses1", status: fake.sessionFails ? "FAILED" : fake.sessionState, lastError: fake.sessionFails ? "нет места" : null });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function reset(over: Partial<Fake> = {}) {
  Object.assign(fake, { admin: true, lint: "ok", regress: "pass", sessionFails: false, calls: [], status: "", cookies: [], upload: "json", testStatus: null, sessionHttp: 200, sessionState: "RUNNING", hang: false }, over);
}

const opts = (over: Record<string, unknown> = {}) => ({ url: base, user: "boss", password: "right", zip: packScenarioDir(scenarioDir()), pollMs: 5, ...over });

describe("pushScenario", () => {
  it("uploads and stops there by default: the moderator checks and publishes", async () => {
    reset();
    const r = await pushScenario(opts());
    expect(r.ok).toBe(true);
    expect(r.status).toBe("UPLOADED");
    expect(r.next).toMatch(/модератор/);
    expect(fake.calls).toEqual(["POST /api/auth/login", "POST /api/author/submissions"]);
  });

  it("sends the session cookie from the login to every later call", async () => {
    reset();
    await pushScenario(opts());
    expect(fake.cookies[1]).toContain("wom_session=abc");
  });

  it("runs the check and reports a pass without publishing", async () => {
    reset();
    const r = await pushScenario(opts({ check: true }));
    expect(r.ok).toBe(true);
    expect(r.status).toBe("PASSED");
    expect(fake.calls.some((c) => c.includes("/approve"))).toBe(false);
  });

  it("publishes after a passed check", async () => {
    reset();
    const r = await pushScenario(opts({ publish: true }));
    expect(r.ok).toBe(true);
    expect(r.status).toBe("APPROVED");
    expect(r.scenarioUrl).toBe(`${base}/scenarios/demo-case`);
    expect(r.sessionUrl).toBeUndefined();
  });

  it("starts a session of the published scenario and returns its address", async () => {
    reset();
    const r = await pushScenario(opts({ start: true }));
    expect(r.ok).toBe(true);
    expect(r.sessionUrl).toBe(`${base}/sessions/ses1`);
  });

  it("does not publish when the regression fails", async () => {
    reset({ regress: "fail" });
    const r = await pushScenario(opts({ publish: true }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("FAILED");
    expect(fake.calls.some((c) => c.includes("/approve"))).toBe(false);
  });

  it("explains that a non-administrator cannot check, and leaves the upload for the moderator", async () => {
    reset({ admin: false });
    const r = await pushScenario(opts({ publish: true }));
    expect(r.ok).toBe(false);
    expect(r.next).toMatch(/администратор/);
    expect(fake.calls.some((c) => c.includes("/approve"))).toBe(false);
  });

  it("returns the lint errors of the platform and goes no further", async () => {
    reset({ lint: "fail" });
    const lines: string[] = [];
    const r = await pushScenario(opts({ check: true, log: (l: string) => lines.push(l) }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("LINT_FAILED");
    expect(lines.join("\n")).toContain("image-base");
    expect(fake.calls.some((c) => c.includes("/test"))).toBe(false);
  });

  it("reports a session that failed to start without hiding the published scenario", async () => {
    reset({ sessionFails: true });
    const r = await pushScenario(opts({ start: true }));
    expect(r.ok).toBe(false);
    expect(r.scenarioUrl).toBe(`${base}/scenarios/demo-case`);
    expect(r.next).toContain("нет места");
  });

  it("rejects a wrong password with a clear error and never uploads", async () => {
    reset();
    await expect(pushScenario(opts({ password: "wrong" }))).rejects.toThrow(/неверный логин или пароль/);
    expect(fake.calls).toEqual(["POST /api/auth/login"]);
  });

  it("refuses to send credentials over plain http to a remote host", async () => {
    await expect(pushScenario(opts({ url: "http://game.example.com" }))).rejects.toThrow(PushError);
  });

  it("sends an Origin that the platform accepts (a wrong one would be refused with 403)", async () => {
    reset();
    await expect(pushScenario(opts())).resolves.toMatchObject({ ok: true });
  });

  it("marks the non-administrator outcome so that the CLI can use a distinct exit code", async () => {
    reset({ admin: false });
    const r = await pushScenario(opts({ check: true }));
    expect(r.needsAdmin).toBe(true);
    expect(r.status).toBe("UPLOADED");
  });

  it("does not take a 404 of the check for a missing role", async () => {
    reset({ testStatus: 404 });
    await expect(pushScenario(opts({ check: true }))).rejects.toThrow(/не запустилась/);
  });

  it("reports a lost session (401) instead of blaming the role", async () => {
    reset({ testStatus: 401 });
    await expect(pushScenario(opts({ check: true }))).rejects.toThrow(/сессия на платформе потеряна/);
  });

  it("rejects an answer that is not the platform API (a maintenance page)", async () => {
    reset({ upload: "html" });
    await expect(pushScenario(opts({ check: true }))).rejects.toThrow(/не так, как ожидалось/);
    expect(fake.calls.some((c) => c.includes("/test"))).toBe(false);
  });

  it("does not follow a redirect with the credentials", async () => {
    reset({ upload: "redirect" });
    await expect(pushScenario(opts())).rejects.toThrow(/перенаправляет/);
  });

  it("gives up on a session status that keeps failing, with a clear error", async () => {
    reset({ sessionHttp: 503 });
    await expect(pushScenario(opts({ start: true }))).rejects.toThrow(/не отдаёт статус сессии/);
  });

  it("stops waiting for a session that expired", async () => {
    reset({ sessionState: "EXPIRED" });
    const r = await pushScenario(opts({ start: true }));
    expect(r.ok).toBe(false);
    expect(r.next).toContain("EXPIRED");
  });

  it("abandons a request that never answers", async () => {
    reset({ hang: true });
    await expect(pushScenario(opts({ start: true, requestTimeoutMs: 100 }))).rejects.toThrow(/нет ответа/);
  });

  it("does not echo an unparsable address that may carry a password", async () => {
    await expect(pushScenario(opts({ url: "https://user:secret@" }))).rejects.not.toThrow(/secret/);
  });

  it("keeps the session cookie when a later response sets another cookie", async () => {
    reset();
    const lines: string[] = [];
    // the fake sets only the session cookie; a proxy cookie is simulated by a custom fetch around it
    let n = 0;
    const wrapped: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      n++;
      if (n < 2) return res;
      const headers = new Headers(res.headers);
      headers.append("set-cookie", "proxy_id=1; Path=/");
      return new Response(await res.text(), { status: res.status, headers });
    };
    const r = await pushScenario(opts({ publish: true, fetchImpl: wrapped, log: (l: string) => lines.push(l) }));
    expect(r.ok).toBe(true);
  });

  it("does not put the password into any log line", async () => {
    reset();
    const lines: string[] = [];
    await pushScenario(opts({ start: true, log: (l: string) => lines.push(l) }));
    expect(lines.join("\n")).not.toContain("right");
  });

  it("does not put the password into the text of an error either", async () => {
    reset({ testStatus: 500 });
    const err = await pushScenario(opts({ check: true })).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("right");
  });
});
