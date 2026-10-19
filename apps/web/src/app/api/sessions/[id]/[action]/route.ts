// POST /api/sessions/:id/check | terminal-token | hints (body: {level})
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, crossOriginResponse, readJson, unauthorized } from "@/lib/http";
import { ORCH_TIMEOUT, orchestrator } from "@/lib/orchestrator";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id, action } = await ctx.params;
  const sid = encodeURIComponent(id);

  if (action === "check" || action === "terminal-token") {
    const r = await orchestrator(`/sessions/${sid}/${action}`, {
      method: "POST",
      body: { userId: user.id },
      timeoutMs: action === "check" ? ORCH_TIMEOUT.check : undefined,
    });
    return NextResponse.json(r.body, { status: r.status });
  }
  if (action === "hints") {
    const json = await readJson<{ level?: number }>(req, { maxBytes: 4 * 1024 });
    if (!json.ok) return json.response;
    const level = Number(json.data.level);
    if (!Number.isInteger(level) || level < 1 || level > 9) return badRequest("Уровень подсказки от 1 до 9");
    const r = await orchestrator(`/sessions/${sid}/hints/${level}`, { method: "POST", body: { userId: user.id } });
    return NextResponse.json(r.body, { status: r.status });
  }
  return badRequest("Неизвестное действие");
}
