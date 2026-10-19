// Ported from fadeinflames/wom-games (src/lib/rate-limit.ts). In-memory: fine for one node (ADR-0006 tech debt).
import { isIP } from "node:net";

type Bucket = { tokens: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let nextPruneAt = 0;

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterMs: number };

export function rateLimit(key: string, opts: { limit: number; windowMs: number }): RateLimitResult {
  const now = Date.now();
  if (now >= nextPruneAt) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    nextPruneAt = now + Math.min(opts.windowMs, 60_000);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { tokens: opts.limit - 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.limit - 1, retryAfterMs: 0 };
  }
  if (bucket.tokens <= 0) return { ok: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  bucket.tokens -= 1;
  return { ok: true, remaining: bucket.tokens, retryAfterMs: 0 };
}

/** Gives a token back: for limits that must count only successful actions (registrations per day). */
export function rateLimitRefund(key: string) {
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt > Date.now()) bucket.tokens += 1;
}

// Caddy is the only proxy in front of web and has no trusted_proxies: it replaces the client's X-Forwarded-For with
// the connection address, so the last list element is the one Caddy wrote. cf-connecting-ip and x-real-ip pass
// through from the client untouched and must not be read at all.
export function clientIpFromRequest(req: Request): string | null {
  const last = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last && isIP(last) ? last : null;
}

const INTERNAL_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const INTERNAL_V6 = /^(::1$|f[cd]|fe[89ab])/;

// For long-lived per-IP quotas (stands per IP, registrations per day). An internal address means the proxy does not
// see real clients (rootless Docker's default port driver hides the source address): every visitor would share one
// quota and lock each other out, so such an address identifies nobody and the quota is skipped.
export function publicClientIp(req: Request): string | null {
  const ip = clientIpFromRequest(req)?.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (!ip || INTERNAL_V4.test(ip) || INTERNAL_V6.test(ip)) return null;
  return ip;
}

export function clientKeyFromRequest(req: Request, prefix: string) {
  return `${prefix}:${clientIpFromRequest(req) ?? "unknown"}`;
}
