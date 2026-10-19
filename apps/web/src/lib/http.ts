// Ported from fadeinflames/wom-games (src/lib/http.ts), trimmed to what slice 1 uses.
import { NextResponse } from "next/server";

const DEFAULT_JSON_MAX_BYTES = 256 * 1024;

export type ReadJsonResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** the declared Content-Length, or null when the header is absent or not a number (chunked body) */
function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length")?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

// Never buffers more than maxBytes: a body that declares a larger length is refused before a byte is read, and a body
// without a length (chunked) is dropped as soon as it crosses the limit. Returns null for an oversized body.
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = unknown>(req: Request, opts: { maxBytes?: number } = {}): Promise<ReadJsonResult<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    return { ok: false, response: badRequest("Ожидается запрос в формате JSON") };
  }
  const bytes = await readBodyCapped(req, maxBytes);
  if (!bytes) return { ok: false, response: tooLarge() };
  const raw = new TextDecoder().decode(bytes);
  if (!raw.trim()) return { ok: false, response: badRequest("Пустое тело запроса") };
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch {
    return { ok: false, response: badRequest("Некорректный JSON") };
  }
}

// CSRF: the session cookie is SameSite=Lax, and Lax does not stop a same-site origin (another subdomain of the parent
// domain). Browsers send Origin with every non-GET request, so a mutating request whose Origin is another host is
// refused. The host is compared with the request's own Host / X-Forwarded-Host, not with WOM_DOMAIN, which is not set
// on LAN and dev installs. Without Origin and Sec-Fetch-Site the client is not a browser (curl, scripts).
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false; // "null" (sandboxed frame, redirect chain) or garbage
    }
    const own = [req.headers.get("host"), ...(req.headers.get("x-forwarded-host")?.split(",") ?? [])];
    return own.some((h) => h?.trim().toLowerCase() === originHost);
  }
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** for every non-GET handler: a 403 response when the request comes from another origin, otherwise null */
export function crossOriginResponse(req: Request): NextResponse | null {
  return isSameOrigin(req) ? null : NextResponse.json({ error: "Запрос с другого сайта отклонён" }, { status: 403 });
}

export const badRequest = (message = "Некорректный запрос") => NextResponse.json({ error: message }, { status: 400 });
export const unauthorized = (message = "Нужно войти заново") => NextResponse.json({ error: message }, { status: 401 });
export const notFound = (message = "Не найдено") => NextResponse.json({ error: message }, { status: 404 });
export const tooLarge = (message = "Слишком большой запрос") => NextResponse.json({ error: message }, { status: 413 });

function waitText(ms: number): string {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  if (sec < 90) return `${sec} с`;
  const min = Math.ceil(sec / 60);
  return min < 120 ? `${min} мин` : `${Math.ceil(min / 60)} ч`;
}

export const tooMany = (retryAfterMs: number, message = "Слишком много запросов.") =>
  NextResponse.json(
    { error: `${message} Попробуй через ${waitText(retryAfterMs)}.` },
    { status: 429, headers: { "Retry-After": Math.max(1, Math.ceil(retryAfterMs / 1000)).toString() } },
  );
