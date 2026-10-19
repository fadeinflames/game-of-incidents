// Admin: stop every active training session (before a restart, or when the host is overloaded).
// Goes through the same orchestrator route as the single kill (see lib/stop-sessions.ts).
import { NextResponse } from "next/server";
import { prisma } from "@wom/db";
import { requireAdminApi } from "@/lib/admin";
import { auditAdmin } from "@/lib/audit";
import { ACTIVE_SESSION_STATUSES } from "@/lib/labels";
import { stopSessions } from "@/lib/stop-sessions";

export async function POST(req: Request) {
  const gate = await requireAdminApi(req);
  if ("response" in gate) return gate.response;

  const active = await prisma.trainingSession.findMany({ where: { status: { in: [...ACTIVE_SESSION_STATUSES] } }, select: { id: true } });
  const { killed, failed } = await stopSessions(active.map((s) => s.id));

  if (failed > 0 && killed === 0) {
    return NextResponse.json({ error: "Платформа стендов не приняла команду. Попробуй ещё раз через минуту.", killed, failed }, { status: 503 });
  }
  auditAdmin({ actor: gate.user.id, action: "kill-all", target: "sessions:all" });
  return NextResponse.json({ killed, failed });
}
