import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { crossOriginResponse, unauthorized } from "@/lib/http";
import { ORCH_TIMEOUT, orchestrator } from "@/lib/orchestrator";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const r = await orchestrator(`/sessions/${encodeURIComponent(id)}?userId=${encodeURIComponent(user.id)}`);
  return NextResponse.json(r.body, { status: r.status });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const r = await orchestrator(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE", body: { userId: user.id }, timeoutMs: ORCH_TIMEOUT.kill });
  return NextResponse.json(r.body, { status: r.status });
}
