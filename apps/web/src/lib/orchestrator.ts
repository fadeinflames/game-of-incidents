// Server-only client for the orchestrator's internal API (ADR-0003). Never imported by client components.
import "server-only";
import type { SessionStatus } from "@wom/db";

const base = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3080";
const token = process.env.INTERNAL_TOKEN ?? "";

export type OrchResponse<T = unknown> = { status: number; body: T };

const DEFAULT_TIMEOUT_MS = 5_000;

export type OrchFailureReason = "timeout" | "connection_refused" | "network_error" | "non_json_response" | "http_5xx";

// One structured line per failed call so "the stand did not start" can be traced to a cause (a restart, a hang, a
// crash). Only the method, the path without its query, the status and a clipped message are written: never the token or a request body.
function logFailure(f: { reason: OrchFailureReason; method: string; path: string; ms: number; status?: number; code?: string; message?: string }) {
  console.error(JSON.stringify({ event: "orchestrator_call_failed", ...f, path: f.path.split("?")[0], at: new Date().toISOString() }));
}

function networkCode(err: unknown): string | undefined {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

// Never throws: while the orchestrator restarts (deploy) or hangs, callers get a 503 with a readable message instead
// of an unhandled ECONNREFUSED. The timeout is per call because the calls differ by orders of magnitude: a status read
// answers in milliseconds, a check waits for the grader for minutes.
export async function orchestrator<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<OrchResponse<T>> {
  const method = init.method ?? "GET";
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { "x-internal-token": token, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const code = networkCode(err);
    logFailure({
      reason: timedOut ? "timeout" : code === "ECONNREFUSED" ? "connection_refused" : "network_error",
      method,
      path,
      ms: Date.now() - started,
      ...(code && { code }),
      message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    const error = timedOut
      ? "Платформа стендов не ответила вовремя. Попробуй ещё раз через минуту."
      : "Платформа стендов сейчас недоступна. Попробуй через минуту.";
    return { status: 503, body: { error } as T };
  }
  let body: unknown = null;
  let parsed = true;
  try {
    body = await res.json();
  } catch {
    parsed = false;
    body = { error: `orchestrator returned ${res.status}` };
  }
  if (!parsed) logFailure({ reason: "non_json_response", method, path, ms: Date.now() - started, status: res.status });
  else if (res.status >= 500) {
    const message = (body as { error?: unknown } | null)?.error;
    logFailure({ reason: "http_5xx", method, path, ms: Date.now() - started, status: res.status, ...(typeof message === "string" && { message: message.slice(0, 200) }) });
  }
  return { status: res.status, body: body as T };
}

/** timeouts for the slow calls; everything else uses the 5 s default */
export const ORCH_TIMEOUT = {
  // the orchestrator waits for the grader up to GRADER_TIMEOUT_MS (240 s by default)
  check: 250_000,
  create: 60_000,
  // destroying a kind cluster takes tens of seconds
  kill: 120_000,
} as const;

export type PlayerSession = {
  id: string;
  scenarioId: string;
  status: SessionStatus;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  finishedAt: string | null;
  startupMs: number | null;
  startupPhase: string | null;
  checkAttempts: number;
  hintsUsed: number[];
  score: number | null;
  result: GraderResult | null;
  lastError: string | null;
};

export type GraderResult =
  | { status: "ok"; passed: boolean; criteria: { id: string; ok: boolean; message: string }[] }
  | { status: "error"; error: string; detail?: string };

export const orchestratorPublicUrl = () => process.env.ORCHESTRATOR_PUBLIC_URL ?? "http://localhost:3080";
