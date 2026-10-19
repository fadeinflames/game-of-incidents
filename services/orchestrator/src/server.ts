// Internal HTTP API (web -> orchestrator, X-Internal-Token) + public WebSocket terminal gateway (ADR-0002/0003).
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { TerminalStream } from "@wom/runtime";
import type { EgressState } from "./guards";
import type { HealthChecks } from "./health";
import type { IpLimitMonitor } from "./ip-limits";
import { logger } from "./logger";
import { QuotaError, StateError, toPlayerView, type SessionService } from "./sessions";
import type { TerminalTokenStore } from "./terminal-tokens";
import type { Reconciler } from "./reconciler";
import type { SubmissionRunner } from "./submissions";

export type ServerDeps = {
  sessions: SessionService;
  tokens: TerminalTokenStore;
  internalToken: string;
  reconciler?: Reconciler;
  submissions?: SubmissionRunner;
  activeSessionCount: () => Promise<number>;
  /** host guards reported by GET /health; unset => disk usage null, egress "off" */
  diskUsedPct?: () => Promise<number | null>;
  egressState?: () => Promise<EgressState>;
  /** runtime and queue signals merged into GET /health (docker reachable, reconciler age, failures, startup time) */
  health?: () => Promise<HealthChecks>;
  /** tells whether the per-address quota can work at all (see ip-limits.ts); unset => every well-formed address is counted and /health has no ipLimits */
  ipLimits?: IpLimitMonitor;
  /** terminal gateway tuning; the defaults are what runs in production */
  terminal?: { pingIntervalMs?: number; maxPerSession?: number };
};

const MAX_BODY = 64 * 1024;
/** the browser sends keystrokes, pastes and resize messages only */
const WS_MAX_PAYLOAD = 1024 * 1024;
/**
 * Terminal output queued for one browser. A sandbox can print faster than the network delivers (`yes`), and ws buffers
 * without limit: above the high mark output is dropped (with a notice) until the queue drains below the low mark.
 */
const TERM_HIGH_WATER = 1024 * 1024;
const TERM_LOW_WATER = 256 * 1024;
const TERM_DROP_TAIL = 16 * 1024;
/** a socket that answered no ping for a whole interval is dead: its docker exec would otherwise live until the session ends */
const TERM_PING_INTERVAL_MS = 30_000;
/** terminals open at once for one session (a reload opens the new socket before the old one is noticed closed); the oldest gives way */
const TERM_MAX_PER_SESSION = 3;
const TERM_MIN_SIZE = 1;
const TERM_MAX_SIZE = 500;
const TERM_DROP_NOTICE = Buffer.from("\r\n\x1b[0m\x1b[33m… вывод пропущен: слишком быстрый поток …\x1b[0m\r\n", "utf8");

export function createServer(deps: ServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      logger.error({ err, url: req.url }, "unhandled");
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: "Внутренняя ошибка платформы. Попробуй ещё раз." });
    });
  });

  const terminals = new Map<string, Set<WebSocket>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  server.on("upgrade", (req, socket, head) => {
    // a reset on a raw socket (before ws takes it over, or while a 401 is written) is an uncaught exception without a listener
    socket.on("error", (err) => logger.debug({ err: err.message }, "upgrade socket error"));
    // anything thrown here runs outside every promise chain and would take the whole process (all terminals) down
    try {
      const url = new URL(req.url ?? "/", "http://localhost"); // throws on a request target like "//"
      const m = url.pathname.match(/^\/ws\/term\/([A-Za-z0-9_-]+)$/);
      if (!m) {
        socket.destroy();
        return;
      }
      const sessionId = m[1];
      const token = url.searchParams.get("token") ?? "";
      const entry = deps.tokens.consume(token, sessionId);
      if (!entry) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // without a listener a protocol error (an oversized or malformed frame) is an uncaught exception for the whole process
        ws.on("error", (err) => logger.warn({ err: err.message, sessionId }, "terminal socket error"));
        attachTerminal(ws, sessionId, deps, terminals).catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, "terminal attach failed");
          ws.close(1011, "attach failed");
        });
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), url: String(req.url).slice(0, 200) }, "terminal upgrade rejected");
      socket.destroy();
    }
  });

  return server;
}

type FlowControl = Pick<TerminalStream, "pause" | "resume">;

/**
 * Forwards terminal output to the browser while the socket's send queue stays under the high-water mark.
 * Over it: when the provider can pause the sandbox stream, reading stops until the queue drains (the process in the
 * sandbox blocks on its own output, nothing is lost and nothing piles up here); otherwise output is dropped. The newest
 * dropped bytes are kept and delivered once the queue drains: a burst usually ends with the shell prompt, and without
 * it the terminal would look hung until the next keystroke.
 */
export function forwardTerminalOutput(
  ws: Pick<WebSocket, "readyState" | "OPEN" | "bufferedAmount" | "send">,
  term?: FlowControl,
): (chunk: Buffer) => void {
  if (term?.pause && term.resume) return forwardWithPause(ws, { pause: term.pause.bind(term), resume: term.resume.bind(term) });
  /** non-null while dropping */
  let tail: Buffer | null = null;
  let poll: NodeJS.Timeout | undefined;
  const keepTail = (chunk: Buffer) => {
    const all = tail && chunk.length < TERM_DROP_TAIL ? Buffer.concat([tail, chunk]) : chunk;
    tail = all.length > TERM_DROP_TAIL ? all.subarray(all.length - TERM_DROP_TAIL) : all;
  };
  const resume = () => {
    clearInterval(poll);
    const rest = tail;
    tail = null;
    if (rest?.length && ws.readyState === ws.OPEN) ws.send(rest);
  };
  return (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    if (tail) {
      if (ws.bufferedAmount > TERM_LOW_WATER) return keepTail(chunk);
      resume();
    } else if (ws.bufferedAmount > TERM_HIGH_WATER) {
      ws.send(TERM_DROP_NOTICE);
      keepTail(chunk);
      // the output may stop right here (the prompt is waiting in the tail), so the drain is watched by a timer too
      poll = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount <= TERM_LOW_WATER) resume();
      }, 100);
      poll.unref();
      return;
    }
    ws.send(chunk);
  };
}

function forwardWithPause(
  ws: Pick<WebSocket, "readyState" | "OPEN" | "bufferedAmount" | "send">,
  flow: { pause: () => void; resume: () => void },
): (chunk: Buffer) => void {
  let paused = false;
  return (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk);
    if (paused || ws.bufferedAmount <= TERM_HIGH_WATER) return;
    paused = true;
    flow.pause();
    const poll = setInterval(() => {
      const open = ws.readyState === ws.OPEN;
      if (open && ws.bufferedAmount > TERM_LOW_WATER) return;
      clearInterval(poll);
      paused = false;
      if (open) flow.resume();
    }, 50);
    poll.unref();
  };
}

function termSize(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(TERM_MAX_SIZE, Math.max(TERM_MIN_SIZE, Math.round(v))) : null;
}

async function attachTerminal(ws: WebSocket, sessionId: string, deps: ServerDeps, terminals: Map<string, Set<WebSocket>>) {
  const maxPerSession = deps.terminal?.maxPerSession ?? TERM_MAX_PER_SESSION;
  const open = terminals.get(sessionId) ?? new Set<WebSocket>();
  terminals.set(sessionId, open);
  open.add(ws);
  while (open.size > maxPerSession) {
    const oldest = open.values().next().value as WebSocket;
    open.delete(oldest);
    oldest.close(4000, "терминал открыт в другом окне");
  }

  // Registered before the first await: a browser that leaves while the shell is still being opened must not leave
  // a docker exec behind that nobody will ever close.
  let term: TerminalStream | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  ws.on("close", () => {
    clearInterval(heartbeat);
    open.delete(ws);
    if (!open.size) terminals.delete(sessionId);
    term?.end();
  });

  const opened = await deps.sessions.openTerminal(sessionId, { cols: 80, rows: 24 });
  if (ws.readyState !== ws.OPEN) {
    opened.end();
    return;
  }
  const t: TerminalStream = opened;
  term = t;

  let inputPaused = false;
  // a connection that vanished without a close frame (a laptop lid, a dead network) keeps the shell otherwise
  let alive = true;
  ws.on("pong", () => (alive = true));
  heartbeat = setInterval(() => {
    // a socket we stopped reading ourselves cannot answer; the session end closes it
    if (inputPaused) alive = true;
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, deps.terminal?.pingIntervalMs ?? TERM_PING_INTERVAL_MS);
  heartbeat.unref();

  t.onData(forwardTerminalOutput(ws, t));
  t.onEnd(() => ws.close(1000, "shell exited"));
  // the sandbox does not take its input (a process that never reads stdin): stop reading the socket instead of buffering the keystrokes here
  t.onDrain?.(() => {
    if (!inputPaused) return;
    inputPaused = false;
    ws.resume();
  });
  const write = (data: Buffer | string) => {
    t.write(data);
    if (!inputPaused && t.writable?.() === false) {
      inputPaused = true;
      ws.pause();
    }
  };
  ws.on("message", (data, isBinary) => {
    alive = true;
    if (isBinary) {
      write(data as Buffer);
      return;
    }
    let msg: { type?: string; cols?: unknown; rows?: unknown; data?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const cols = termSize(msg.cols);
    const rows = termSize(msg.rows);
    if (msg.type === "resize" && cols && rows) void t.resize(cols, rows).catch(() => {});
    else if (msg.type === "input" && typeof msg.data === "string") write(msg.data);
    else if (msg.type === "ping" && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "pong" }));
  });
  logger.info({ sessionId }, "terminal attached");
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/health" && req.method === "GET") {
    const [activeSessions, usedPct, egress, checks] = await Promise.all([
      deps.activeSessionCount(),
      deps.diskUsedPct?.() ?? null,
      deps.egressState?.() ?? ("off" as const),
      // the extra signals must never take the endpoint down: it is what the platform's own healthcheck calls
      deps.health?.().catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "health checks failed");
        return null;
      }) ?? null,
    ]);
    // ok:false still comes with HTTP 200: the web proxy reads the status code as "the service is down", and a stuck
    // reconciler or a dead daemon is a degradation to alert on, not a reason to take the site out of rotation
    json(res, 200, { ok: !checks?.degraded.length, activeSessions, disk: { usedPct }, egress, draining: deps.sessions.isDraining(), ...(deps.ipLimits ? { ipLimits: deps.ipLimits.status() } : {}), ...(checks ?? {}) });
    return;
  }

  if (!authorized(req, deps.internalToken)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    if (path === "/sessions" && req.method === "POST") {
      const body = await readJson(req);
      const userId = str(body.userId);
      const scenarioId = str(body.scenarioId);
      if (!userId || !scenarioId) return json(res, 400, { error: "userId and scenarioId required" });
      // only a well-formed address counts towards the per-address quota: a placeholder ("unknown") would pool everyone together
      const clientIp = str(body.clientIp).trim();
      const counted = deps.ipLimits ? deps.ipLimits.observe(clientIp) : isIP(clientIp) ? clientIp : undefined;
      const s = await deps.sessions.create(userId, scenarioId, { clientIp: counted });
      return json(res, 201, await deps.sessions.playerView(s));
    }

    const m = path.match(/^\/sessions\/([A-Za-z0-9_-]+)(?:\/([a-z-]+)(?:\/(\d+))?)?$/);
    if (m) {
      const [, id, action, arg] = m;
      // an unknown action is a 404 before any database work
      if (action && !SESSION_ACTIONS.has(action)) return json(res, 404, { error: "not found" });
      const body = req.method === "GET" ? {} : await readJson(req);
      const userId = str(body.userId) || url.searchParams.get("userId") || "";
      const session = userId ? await deps.sessions.getOwned(id, userId) : null;
      if (!session) return json(res, 404, { error: "Сессия не найдена." });

      if (!action && req.method === "GET") return json(res, 200, await deps.sessions.playerView(session));
      if (!action && req.method === "DELETE") {
        await deps.sessions.kill(id, "killed by user");
        return json(res, 200, toPlayerView((await deps.sessions.get(id))!));
      }
      if (action === "check" && req.method === "POST") {
        const { session: s, result } = await deps.sessions.check(id);
        return json(res, 200, { session: toPlayerView(s), result });
      }
      if (action === "terminal-token" && req.method === "POST") {
        await deps.sessions.terminalTarget(id); // throws unless RUNNING
        return json(res, 200, { token: deps.tokens.issue(id, userId) });
      }
      if (action === "hints" && req.method === "POST" && arg) {
        const hint = await deps.sessions.useHint(id, Number(arg));
        return json(res, 200, hint);
      }
    }

    const sm = path.match(/^\/submissions\/([A-Za-z0-9_-]+)\/test$/);
    if (sm && req.method === "POST") {
      if (!deps.submissions) return json(res, 503, { error: "submission runner is not configured" });
      return json(res, 202, deps.submissions.enqueue(sm[1]));
    }

    if (path === "/capacity" && req.method === "GET") return json(res, 200, await deps.sessions.capacity());

    // a deploy asks for this before it restarts the orchestrator: new sessions are refused, running ones are left alone
    if (path === "/admin/drain" && req.method === "POST") {
      const body = await readJson(req);
      deps.sessions.setDraining(body.draining !== false);
      return json(res, 200, { draining: deps.sessions.isDraining() });
    }

    if (path === "/admin/reconcile" && req.method === "POST") {
      if (!deps.reconciler) return json(res, 503, { error: "reconciler is not configured" });
      return json(res, 200, await deps.reconciler.run());
    }

    // admin panel: stop any session regardless of its owner (the web app checks the admin role)
    const am = path.match(/^\/admin\/sessions\/([A-Za-z0-9_-]+)$/);
    if (am && req.method === "DELETE") {
      const s = await deps.sessions.get(am[1]);
      if (!s) return json(res, 404, { error: "Сессия не найдена." });
      await deps.sessions.kill(am[1], "killed by admin");
      return json(res, 200, toPlayerView((await deps.sessions.get(am[1]))!));
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof QuotaError) return json(res, 429, { error: err.message, ...(err.activeSessionId ? { activeSessionId: err.activeSessionId } : {}) });
    if (err instanceof StateError) return json(res, 409, { error: err.message, code: err.code });
    if (err instanceof BodyError) return json(res, 400, { error: err.message });
    throw err;
  }
}

/** the sub-paths of /sessions/<id> that exist */
const SESSION_ACTIONS = new Set(["check", "terminal-token", "hints"]);

class BodyError extends Error {}

function authorized(req: http.IncomingMessage, expected: string): boolean {
  const got = req.headers["x-internal-token"];
  if (typeof got !== "string" || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BodyError("body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    throw new BodyError("malformed JSON");
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
