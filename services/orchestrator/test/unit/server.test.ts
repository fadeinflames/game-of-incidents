// HTTP routes and the terminal gateway with a stubbed SessionService and the fake runtime: no database, no Docker.
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { FakeRuntimeProvider, type TerminalStream } from "@wom/runtime";
import { IpLimitMonitor } from "../../src/ip-limits";
import { logger } from "../../src/logger";
import { createServer, forwardTerminalOutput, type ServerDeps } from "../../src/server";
import { QuotaError, StateError, type SessionService } from "../../src/sessions";
import { TerminalTokenStore } from "../../src/terminal-tokens";

const TOKEN = "internal-token";
const MB = 1024 * 1024;

type Stub = Partial<Record<string, unknown>>;

let server: http.Server | undefined;
const sockets: WebSocket[] = [];

async function start(sessions: Stub = {}, extra: Partial<ServerDeps> = {}) {
  const tokens = new TerminalTokenStore(60_000);
  const deps: ServerDeps = {
    sessions: { isDraining: () => false, setDraining: () => {}, ...sessions } as unknown as SessionService,
    tokens,
    internalToken: TOKEN,
    activeSessionCount: async () => 2,
    ...extra,
  };
  server = createServer(deps);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, tokens, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) if (ws.readyState === WebSocket.OPEN) ws.terminate();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const call = (base: string, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) =>
  fetch(base + path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.token === null ? {} : { "x-internal-token": init.token ?? TOKEN }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe("HTTP API", () => {
  it("GET /health needs no token and reports host guards, drain state and the health checks", async () => {
    const { base } = await start({}, { diskUsedPct: async () => 41, egressState: async () => "ok", health: async () => ({ docker: "ok", lastReconcileAgoSec: 3, failedLastHour: 0, queued: 1, startupP95Ms: 9000, degraded: [] }) });
    const r = await call(base, "/health", { token: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      activeSessions: 2,
      disk: { usedPct: 41 },
      egress: "ok",
      draining: false,
      docker: "ok",
      lastReconcileAgoSec: 3,
      failedLastHour: 0,
      queued: 1,
      startupP95Ms: 9000,
      degraded: [],
    });
  });

  it("GET /health says ok:false with the reasons but keeps HTTP 200 when the platform is degraded", async () => {
    const { base } = await start({}, { health: async () => ({ docker: "down", lastReconcileAgoSec: 900, failedLastHour: 8, queued: 0, startupP95Ms: null, degraded: ["docker-down", "reconciler-stale", "failed-sessions-burst"] }) });
    const r = await call(base, "/health", { token: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: false,
      degraded: ["docker-down", "reconciler-stale", "failed-sessions-burst"],
      docker: "down",
      lastReconcileAgoSec: 900,
      failedLastHour: 8,
    });
  });

  it("GET /health still answers when the extra checks fail", async () => {
    const { base } = await start({}, { health: async () => Promise.reject(new Error("db down")) });
    const r = await call(base, "/health", { token: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, activeSessions: 2, egress: "off" });
  });

  it("GET /health reports whether the per-address limits can work, and says so when only internal addresses arrive", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const create = vi.fn(async () => ({ id: "s1" }));
    const ipLimits = new IpLimitMonitor();
    const { base } = await start({ create, playerView: async (s: unknown) => s }, { ipLimits });
    expect(((await (await call(base, "/health", { token: null })).json()) as { ipLimits: string }).ipLimits).toBe("active");
    for (let i = 0; i < 3; i++) await call(base, "/sessions", { method: "POST", body: { userId: "u", scenarioId: "s", clientIp: "172.18.0.4" } });
    expect(((await (await call(base, "/health", { token: null })).json()) as { ipLimits: string }).ipLimits).toBe("skipped-internal");
    // the internal address is not counted towards anyone's quota
    expect(create).toHaveBeenLastCalledWith("u", "s", { clientIp: undefined });
    await call(base, "/sessions", { method: "POST", body: { userId: "u", scenarioId: "s", clientIp: "203.0.113.7" } });
    expect(create).toHaveBeenLastCalledWith("u", "s", { clientIp: "203.0.113.7" });
    expect(((await (await call(base, "/health", { token: null })).json()) as { ipLimits: string }).ipLimits).toBe("active");
  });

  it("GET /health has no ipLimits field where nothing watches the addresses", async () => {
    const { base } = await start();
    expect(await (await call(base, "/health", { token: null })).json()).not.toHaveProperty("ipLimits");
  });

  it("refuses everything else without the internal token", async () => {
    const { base } = await start();
    expect((await call(base, "/sessions", { method: "POST", body: {}, token: null })).status).toBe(401);
    expect((await call(base, "/capacity", { token: "wrong" })).status).toBe(401);
  });

  it("a quota refusal is 429 with the text and the id of the player's own running session", async () => {
    const { base } = await start({
      create: async () => {
        throw new QuotaError("У тебя уже идёт сессия.", "sess-1");
      },
    });
    const r = await call(base, "/sessions", { method: "POST", body: { userId: "u", scenarioId: "s" } });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "У тебя уже идёт сессия.", activeSessionId: "sess-1" });
  });

  it("a quota refusal without a session has no activeSessionId", async () => {
    const { base } = await start({
      create: async () => {
        throw new QuotaError("Все слоты заняты.");
      },
    });
    const r = await call(base, "/sessions", { method: "POST", body: { userId: "u", scenarioId: "s" } });
    expect(await r.json()).toEqual({ error: "Все слоты заняты." });
  });

  it("a state error is 409 with a Russian text and a code", async () => {
    const { base } = await start({
      getOwned: async () => ({ id: "s1" }),
      check: async () => {
        throw new StateError("not-running", "Сессия не запущена: возможно, она уже завершена.");
      },
    });
    const r = await call(base, "/sessions/s1/check", { method: "POST", body: { userId: "u" } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "Сессия не запущена: возможно, она уже завершена.", code: "not-running" });
  });

  it("an unexpected error is 500 and never shows its message", async () => {
    const { base } = await start({
      create: async () => {
        throw new Error("connect ECONNREFUSED /var/run/docker.sock");
      },
    });
    const r = await call(base, "/sessions", { method: "POST", body: { userId: "u", scenarioId: "s" } });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).not.toContain("docker.sock");
    expect(body.error).toMatch(/[а-я]/i);
  });

  it("an unknown or foreign session is 404 in Russian", async () => {
    const { base } = await start({ getOwned: async () => null });
    const r = await call(base, "/sessions/nope?userId=u");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "Сессия не найдена." });
  });

  it("an unknown session action is 404 without touching the database", async () => {
    const getOwned = vi.fn(async () => ({ id: "s1" }));
    const { base } = await start({ getOwned });
    const r = await call(base, "/sessions/s1/unknown", { method: "POST", body: { userId: "u" } });
    expect(r.status).toBe(404);
    expect(getOwned).not.toHaveBeenCalled();
  });

  it("POST /admin/reconcile is 503 when no reconciler is configured", async () => {
    const { base } = await start();
    expect((await call(base, "/admin/reconcile", { method: "POST", body: {} })).status).toBe(503);
  });

  it("POST /admin/drain switches the drain mode on and off", async () => {
    let draining = false;
    const { base } = await start({ isDraining: () => draining, setDraining: (on: boolean) => void (draining = on) });
    expect(await (await call(base, "/admin/drain", { method: "POST", body: {} })).json()).toEqual({ draining: true });
    expect(await (await call(base, "/health", { token: null })).json()).toMatchObject({ draining: true });
    expect(await (await call(base, "/admin/drain", { method: "POST", body: { draining: false } })).json()).toEqual({ draining: false });
  });
});

describe("terminal gateway", () => {
  let runtime: FakeRuntimeProvider;
  // one state object per test: a callback of the previous test that arrives late must not count in this one
  let state: { opened: TerminalStream[]; resizes: [number, number][]; ended: number; openDelayMs: number };

  beforeEach(() => {
    runtime = new FakeRuntimeProvider();
    state = { opened: [], resizes: [], ended: 0, openDelayMs: 0 };
  });

  const terminalSessions = (): Stub => {
    const st = state;
    return {
      openTerminal: async () => {
        if (st.openDelayMs) await new Promise((r) => setTimeout(r, st.openDelayMs));
        const handle = { provider: "docker" as const, containerId: runtime.addOrphan(null), networkId: "n" };
        const term = await runtime.openTerminal(handle, { user: "u", shell: "/bin/sh", cwd: "/", cols: 80, rows: 24 });
        const wrapped: TerminalStream = {
          ...term,
          resize: async (c, r) => void st.resizes.push([c, r]),
          end: () => {
            st.ended++;
            term.end();
          },
        };
        st.opened.push(wrapped);
        return wrapped;
      },
    };
  };

  type Client = { ws: WebSocket; messages: string[]; closed: Promise<number> };
  function connect(port: number, tokens: TerminalTokenStore, sessionId = "s1", opts: { autoPong?: boolean } = {}): Promise<Client> {
    const token = tokens.issue(sessionId, "u1");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${sessionId}?token=${token}`, { autoPong: opts.autoPong ?? true });
    sockets.push(ws);
    const messages: string[] = [];
    ws.on("message", (d) => messages.push(d.toString()));
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve({ ws, messages, closed }));
      ws.once("error", reject);
    });
  }

  const until = async (pred: () => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error("timeout waiting");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("rejects a connection with an unknown token", async () => {
    const { port } = await start(terminalSessions());
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/s1?token=nope`);
    sockets.push(ws);
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("accepts a token once", async () => {
    const { port, tokens } = await start(terminalSessions());
    const token = tokens.issue("s1", "u1");
    const url = `ws://127.0.0.1:${port}/ws/term/s1?token=${token}`;
    const first = new WebSocket(url);
    sockets.push(first);
    await new Promise((resolve, reject) => (first.once("open", resolve), first.once("error", reject)));
    const second = new WebSocket(url);
    sockets.push(second);
    const status = await new Promise<number>((resolve) => second.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("passes keystrokes to the sandbox and its output back", async () => {
    const { port, tokens } = await start(terminalSessions());
    const c = await connect(port, tokens);
    c.ws.send(JSON.stringify({ type: "input", data: "ls" }));
    await until(() => c.messages.includes("echo:ls"));
  });

  it("clamps the terminal size and ignores sizes that are not numbers", async () => {
    const { port, tokens } = await start(terminalSessions());
    const c = await connect(port, tokens);
    await until(() => state.opened.length === 1);
    c.ws.send(JSON.stringify({ type: "resize", cols: 99999, rows: -5 }));
    c.ws.send(JSON.stringify({ type: "resize", cols: "wide", rows: 24 }));
    c.ws.send(JSON.stringify({ type: "resize", cols: 120.4, rows: 40 }));
    await until(() => state.resizes.length === 2);
    expect(state.resizes).toEqual([
      [500, 1],
      [120, 40],
    ]);
  });

  it("ends the shell of a browser that left while the shell was still being opened", async () => {
    state.openDelayMs = 150;
    const { port, tokens } = await start(terminalSessions());
    const c = await connect(port, tokens);
    c.ws.close();
    await c.closed;
    await until(() => state.opened.length === 1);
    await until(() => state.ended === 1);
  });

  it("ends the shell when the browser closes", async () => {
    const { port, tokens } = await start(terminalSessions());
    const c = await connect(port, tokens);
    await until(() => state.opened.length === 1);
    c.ws.close();
    await c.closed;
    await until(() => state.ended === 1);
  });

  it("keeps a limited number of terminals per session: the oldest is closed", async () => {
    const { port, tokens } = await start(terminalSessions(), { terminal: { maxPerSession: 2 } });
    const a = await connect(port, tokens);
    await until(() => state.opened.length === 1);
    const b = await connect(port, tokens);
    await until(() => state.opened.length === 2);
    const other = await connect(port, tokens, "s2");
    const c = await connect(port, tokens);
    expect(await a.closed).toBe(4000);
    await until(() => state.ended === 1);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("drops a client that stops answering pings and ends its shell, and keeps one that answers", async () => {
    const { port, tokens } = await start(terminalSessions(), { terminal: { pingIntervalMs: 40 } });
    const alive = await connect(port, tokens, "s1");
    const dead = await connect(port, tokens, "s2", { autoPong: false });
    await dead.closed;
    await until(() => state.ended === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("stops reading the browser while the sandbox does not take its input, and goes on once it does", async () => {
    const { port, tokens } = await start(terminalSessions());
    const c = await connect(port, tokens);
    await until(() => state.opened.length === 1);
    runtime.terminalInputFull = true;
    c.ws.send(JSON.stringify({ type: "input", data: "a" }));
    await until(() => c.messages.includes("echo:a"));
    await new Promise((r) => setTimeout(r, 100)); // the pause has to be in effect before the next frame arrives
    c.ws.send(JSON.stringify({ type: "input", data: "b" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(c.messages).not.toContain("echo:b");
    runtime.drainTerminalInput();
    await until(() => c.messages.includes("echo:b"));
  });
});

describe("forwardTerminalOutput with a stream that can pause", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  function fakeSocket() {
    const sent: Buffer[] = [];
    const ws = { OPEN: 1 as const, readyState: 1 as number, bufferedAmount: 0, send: (data: Buffer) => void sent.push(data) };
    return { ws, sent };
  }

  it("pauses the sandbox stream over the high-water mark instead of dropping output, and resumes after the queue drains", () => {
    const { ws, sent } = fakeSocket();
    const flow = { pause: vi.fn(), resume: vi.fn() };
    const forward = forwardTerminalOutput(ws as never, flow);
    forward(Buffer.from("a"));
    expect(flow.pause).not.toHaveBeenCalled();
    ws.bufferedAmount = MB + 1;
    forward(Buffer.from("b")); // sent, then the stream is paused: nothing is dropped
    expect(sent.map(String)).toEqual(["a", "b"]);
    expect(flow.pause).toHaveBeenCalledTimes(1);
    ws.bufferedAmount = 512 * 1024; // still over the low mark
    vi.advanceTimersByTime(200);
    expect(flow.resume).not.toHaveBeenCalled();
    ws.bufferedAmount = 100 * 1024;
    vi.advanceTimersByTime(100);
    expect(flow.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // the next burst pauses again
    ws.bufferedAmount = 2 * MB;
    forward(Buffer.from("c"));
    expect(flow.pause).toHaveBeenCalledTimes(2);
  });

  it("does not resume a stream whose socket closed while it was paused", () => {
    const { ws } = fakeSocket();
    const flow = { pause: vi.fn(), resume: vi.fn() };
    const forward = forwardTerminalOutput(ws as never, flow);
    ws.bufferedAmount = 2 * MB;
    forward(Buffer.from("a"));
    ws.readyState = 3;
    vi.advanceTimersByTime(100);
    expect(flow.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to dropping when the stream cannot pause", () => {
    const { ws, sent } = fakeSocket();
    const forward = forwardTerminalOutput(ws as never, {});
    ws.bufferedAmount = 2 * MB;
    forward(Buffer.from("a"));
    expect(sent).toHaveLength(1);
    expect(sent[0].toString()).toContain("вывод пропущен");
  });
});
