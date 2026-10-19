// Ported from fadeinflames/wom-games (src/app/api/auth/login/route.ts).
import { NextResponse } from "next/server";
import { createSession, loginUser } from "@/lib/auth";
import { contactUrl, NO_CONTACT_TEXT } from "@/components/contact-link";
import { loginSchema } from "@/lib/validation";
import { badRequest, crossOriginResponse, readJson, tooMany, unauthorized } from "@/lib/http";
import { hashIdentity } from "@/lib/audit";
import { clientIpFromRequest, clientKeyFromRequest, rateLimit, rateLimitRefund } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  const gate = rateLimit(clientKeyFromRequest(req, "login"), { limit: 10, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterMs);

  // a login body is a few dozen bytes: the default 256 KB cap is generous, 16 KB keeps unauthenticated reads small
  const json = await readJson(req, { maxBytes: 16 * 1024 });
  if (!json.ok) return json.response;
  const parsed = loginSchema.safeParse(json.data);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Некорректные данные");

  // per-account limit: the per-IP one alone does not stop password guessing spread over many addresses.
  // Keyed by the submitted identity whether or not the account exists, so the answer does not reveal which names exist.
  const accountKey = `login-identity:${parsed.data.identity}`;
  const accountGate = rateLimit(accountKey, { limit: 10, windowMs: 15 * 60_000 });
  if (!accountGate.ok) return tooMany(accountGate.retryAfterMs, "Слишком много попыток входа с этим логином.");

  const user = await loginUser(parsed.data);
  if (!user) {
    // a trail for spotting guessing: a digest of the name that was tried and where from; the raw string may be a password typed into the wrong field
    console.warn(JSON.stringify({ event: "login_failed", identity_hash: hashIdentity(parsed.data.identity), ip: clientIpFromRequest(req) ?? "unknown" }));
    return unauthorized("Неверный логин или пароль");
  }
  if ("disabled" in user) return NextResponse.json({ error: `Учётная запись отключена за неактивность. ${contactUrl() ? "Напиши администратору." : NO_CONTACT_TEXT}` }, { status: 403 });

  await createSession(user.id);
  // only failed attempts count: the administrator's own logins (and repeated e2e runs) must not lock the account
  rateLimitRefund(accountKey);
  return NextResponse.json({ ok: true });
}
