// Client-side fetch wrapper for the forms and buttons. Never throws: a dropped connection, a timeout and a non-JSON
// answer all come back as { ok: false, error } with a message that is ready to show, so a button cannot hang in its
// "busy" state because of an unhandled rejection.

export type PostJsonResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string; data: Record<string, unknown> };

export type PostJsonOptions = {
  /** POST by default; the session stop is a DELETE */
  method?: "POST" | "DELETE";
  /** per call, because the calls differ by orders of magnitude: a button answers in a second, a check waits for the grader */
  timeoutMs?: number;
};

export const POST_TIMEOUT_MS = {
  default: 30_000,
  /** the orchestrator waits up to 60 s for a stand to be created */
  start: 70_000,
  /** the orchestrator waits for the grader up to 240 s */
  check: 260_000,
  /** destroying a kind cluster takes tens of seconds */
  stop: 130_000,
  /** an archive of several megabytes over a slow link */
  upload: 120_000,
} as const;

export const NETWORK_ERROR = "Нет связи с сервером. Проверь интернет и попробуй ещё раз.";
export const TIMEOUT_ERROR = "Сервер не ответил вовремя. Обнови страницу: возможно, действие уже выполнилось.";

const STATUS_ERROR: Record<number, string> = {
  413: "Слишком большой запрос. Уменьши размер и попробуй ещё раз.",
  429: "Слишком много попыток. Подожди немного и повтори.",
  502: "Сервер сейчас недоступен. Попробуй через минуту.",
  503: "Сервер сейчас недоступен. Попробуй через минуту.",
  504: "Сервер не ответил вовремя. Попробуй через минуту.",
};

function errorText(status: number, data: Record<string, unknown>): string {
  if (typeof data.error === "string" && data.error) return data.error;
  return STATUS_ERROR[status] ?? `Ошибка ${status}`;
}

/** `body`: a plain object is sent as JSON, a FormData as is, undefined as an empty JSON object for POST */
export async function postJson<T = Record<string, any>>(url: string, body?: unknown, options: PostJsonOptions = {}): Promise<PostJsonResult<T>> {
  const method = options.method ?? "POST";
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: isForm || method === "DELETE" ? undefined : { "content-type": "application/json" },
      body: isForm ? (body as FormData) : method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? POST_TIMEOUT_MS.default),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, status: 0, error: timedOut ? TIMEOUT_ERROR : NETWORK_ERROR, data: {} };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // an empty or non-JSON body (a proxy error page): the status alone decides
  }
  if (!res.ok) return { ok: false, status: res.status, error: errorText(res.status, data), data };
  return { ok: true, status: res.status, data: data as T };
}
