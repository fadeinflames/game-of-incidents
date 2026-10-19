// Admin: enable / disable an account, change its role, reset its password (a one-time password is returned once).
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@wom/db";
import { requireAdminApi } from "@/lib/admin";
import { auditAdmin } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/http";
import { ACTIVE_SESSION_STATUSES } from "@/lib/labels";
import { stopSessions } from "@/lib/stop-sessions";

type Ctx = { params: Promise<{ id: string; action: string }> };

function oneTimePassword() {
  // 12 chars from an unambiguous alphabet; shown to the admin once, the user changes it after the first login
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function POST(req: Request, ctx: Ctx) {
  const gate = await requireAdminApi(req);
  if ("response" in gate) return gate.response;
  const { id, action } = await ctx.params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, role: true, disabledAt: true } });
  if (!target) return notFound("Пользователь не найден");
  const self = target.id === gate.user.id;
  const audit = (what: string) => auditAdmin({ actor: gate.user.id, action: what, target: `user:${id}` });

  switch (action) {
    case "disable": {
      if (self) return badRequest("Нельзя отключить самого себя");
      await prisma.user.update({ where: { id }, data: { disabledAt: new Date() } });
      await prisma.session.deleteMany({ where: { userId: id } }); // browser sessions end immediately
      audit("disable");
      // the account is already off, so no new stand can start; stop the running ones instead of leaving them for up to 4 hours.
      // A failure here must not undo or block the disabling: it is reported in the answer instead.
      let stopped = 0;
      let stopFailed = 0;
      try {
        const active = await prisma.trainingSession.findMany({ where: { userId: id, status: { in: [...ACTIVE_SESSION_STATUSES] } }, select: { id: true } });
        ({ killed: stopped, failed: stopFailed } = await stopSessions(active.map((s) => s.id)));
      } catch {
        stopFailed = -1; // the list itself could not be read
      }
      return NextResponse.json({
        ok: true,
        disabledAt: new Date().toISOString(),
        stopped,
        stopFailed: Math.max(stopFailed, 0),
        ...(stopFailed !== 0 && { warning: "Учётка отключена, но стенд пользователя остановить не удалось. Останови его на странице «Сессии»." }),
      });
    }
    case "enable": {
      await prisma.user.update({ where: { id }, data: { disabledAt: null, lastLoginAt: new Date() } });
      audit("enable");
      return NextResponse.json({ ok: true });
    }
    case "make-admin": {
      await prisma.user.update({ where: { id }, data: { role: "admin" } });
      audit("make-admin");
      return NextResponse.json({ ok: true, role: "admin" });
    }
    case "make-user": {
      if (self) return badRequest("Нельзя снять роль администратора с самого себя");
      await prisma.user.update({ where: { id }, data: { role: "user" } });
      audit("make-user");
      return NextResponse.json({ ok: true, role: "user" });
    }
    case "reset-password": {
      const password = oneTimePassword();
      const passwordHash = await bcrypt.hash(password, 10);
      await prisma.user.update({ where: { id }, data: { passwordHash } });
      await prisma.session.deleteMany({ where: { userId: id } });
      audit("reset-password");
      return NextResponse.json({ ok: true, password });
    }
    default:
      return badRequest("Неизвестное действие");
  }
}
