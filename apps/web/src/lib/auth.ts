// Ported from fadeinflames/wom-games (src/lib/auth.ts @ main 2026-05-10) with minimal changes:
// prisma import from @wom/db; `role` is read for the admin pages and API routes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@wom/db";

const COOKIE_NAME = "wom_session";
const SESSION_DAYS = 30;
const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;

// Pre-computed dummy hash for timing-safe login: prevents user enumeration
// by ensuring bcrypt.compare runs even when the user is not found.
const DUMMY_HASH = "$2b$10$abcdefghijklmnopqrstuuMh6gkBN5Nt/3bGsN2ABdX7bR1jvkXfC";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqualsHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
  await prisma.session.create({ data: { userId, tokenHash, expiresAt } });

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    expires: expiresAt,
    maxAge: SESSION_MAX_AGE_SECONDS,
    priority: "high",
  });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }
  jar.delete(COOKIE_NAME);
}

export type CurrentUser = { id: string; email: string | null; username: string; role: string };

// cached for the duration of one render: the layout, the page and its metadata all ask, and each ask used to be a database round trip
export const getCurrentUser = cache(loadCurrentUser);

async function loadCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenHash = sha256(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      expiresAt: true,
      user: { select: { id: true, email: true, username: true, role: true, disabledAt: true, lastLoginAt: true } },
    },
  });

  if (!session || !constantTimeEqualsHex(session.tokenHash, tokenHash)) return null;
  if (session.user.disabledAt) return null; // disabled accounts lose their sessions immediately

  if (session.expiresAt < new Date()) {
    try {
      await prisma.session.delete({ where: { id: session.id } });
    } catch {
      // ignore: read-only Server Component context
    }
    return null;
  }
  // "activity" = any authenticated request, throttled to once an hour: the inactivity janitor must not disable people
  // who use the site daily without re-entering a password (the cookie lives 30 days)
  const { disabledAt: _d, lastLoginAt, ...user } = session.user;
  if (!lastLoginAt || Date.now() - lastLoginAt.getTime() > 60 * 60 * 1000) {
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
  }
  return user;
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function registerUser(input: { email?: string; username: string; password: string }) {
  const passwordHash = await bcrypt.hash(input.password, 10);
  return prisma.user.create({
    data: { email: input.email ? input.email.toLowerCase() : null, username: input.username.toLowerCase(), passwordHash, lastLoginAt: new Date() },
  });
}

export async function loginUser(input: { identity: string; password: string }) {
  const identity = input.identity.toLowerCase();
  const user = await prisma.user.findFirst({ where: { OR: [{ email: identity }, { username: identity }] } });
  // Always run bcrypt.compare to keep timing roughly constant whether or not the account exists.
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
  const isValid = await bcrypt.compare(input.password, hashToCompare);
  if (!user || !isValid) return null;
  if (user.disabledAt) return { disabled: true } as const;
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return user;
}
