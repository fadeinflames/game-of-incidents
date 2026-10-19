// Ported from fadeinflames/wom-games (src/app/api/auth/register/route.ts).
import { NextResponse } from "next/server";
import { Prisma } from "@wom/db";
import { createSession, registerUser } from "@/lib/auth";
import { contactUrl, NO_CONTACT_TEXT } from "@/components/contact-link";
import { registerSchema } from "@/lib/validation";
import { registrationEnabled } from "@/lib/env";
import { badRequest, crossOriginResponse, readJson, tooMany } from "@/lib/http";
import { clientKeyFromRequest, publicClientIp, rateLimit, rateLimitRefund } from "@/lib/rate-limit";

// 0 = no daily cap
const registrationsPerIpPerDay = () => {
  const n = Number(process.env.REGISTRATIONS_PER_IP_PER_DAY || 5);
  return Number.isInteger(n) && n >= 0 ? n : 5;
};

export async function POST(req: Request) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  // registration is open by default; REGISTRATION_ENABLED=false closes it (accounts are then created by the admin)
  if (!registrationEnabled()) return NextResponse.json({ error: `Регистрация закрыта. ${contactUrl() ? "Обратись к администратору." : NO_CONTACT_TEXT}` }, { status: 403 });
  const gate = rateLimit(clientKeyFromRequest(req, "register"), { limit: 5, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterMs);

  const json = await readJson(req, { maxBytes: 16 * 1024 });
  if (!json.ok) return json.response;
  const parsed = registerSchema.safeParse(json.data);
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Некорректные данные");

  // daily cap of accounts per address (multi-account abuse of session slots); in-memory, resets on restart
  const ip = publicClientIp(req);
  const dayKey = ip && registrationsPerIpPerDay() > 0 ? `register-day:${ip}` : null;
  const dayGate = dayKey ? rateLimit(dayKey, { limit: registrationsPerIpPerDay(), windowMs: 24 * 60 * 60_000 }) : null;
  if (dayGate && !dayGate.ok) return tooMany(dayGate.retryAfterMs, "С твоего адреса сегодня уже создано слишком много учётных записей.");

  try {
    const user = await registerUser({ ...parsed.data, email: parsed.data.email || undefined });
    await createSession(user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (dayKey) rateLimitRefund(dayKey); // only created accounts count
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Такое имя пользователя уже занято" }, { status: 409 });
    }
    throw err;
  }
}
