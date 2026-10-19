// Structured JSON logs to stdout (one line per event). No dependency: keeps the service small.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** "INFO" works, a typo falls back to info: an unknown level must not switch every debug line on */
export function parseLevel(raw: string | undefined): Level {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "warning") return "warn";
  return Object.hasOwn(order, v) ? (v as Level) : "info";
}

const minLevel = parseLevel(process.env.LOG_LEVEL);

function emit(level: Level, fields: Record<string, unknown>, msg: string) {
  if (order[level] < order[minLevel]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...serialize(fields) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

const MAX_CAUSE_DEPTH = 3;

/** name/message/stack, the error's own fields (code, errno, ...) and its cause chain */
export function serializeError(err: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { ...err, name: err.name, message: err.message, stack: err.stack };
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = cause instanceof Error && depth < MAX_CAUSE_DEPTH ? serializeError(cause, depth + 1) : String(cause);
  return out;
}

function serialize(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? serializeError(v) : v;
  return out;
}

export const logger = {
  debug: (fields: Record<string, unknown>, msg: string) => emit("debug", fields, msg),
  info: (fields: Record<string, unknown>, msg: string) => emit("info", fields, msg),
  warn: (fields: Record<string, unknown>, msg: string) => emit("warn", fields, msg),
  error: (fields: Record<string, unknown>, msg: string) => emit("error", fields, msg),
};
