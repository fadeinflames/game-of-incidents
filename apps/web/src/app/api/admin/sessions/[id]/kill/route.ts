// Admin: stop any training session (the orchestrator destroys the sandbox / cluster).
import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin";
import { auditAdmin } from "@/lib/audit";
import { ORCH_TIMEOUT, orchestrator } from "@/lib/orchestrator";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await requireAdminApi(req);
  if ("response" in gate) return gate.response;
  const { id } = await ctx.params;
  const r = await orchestrator(`/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE", body: {}, timeoutMs: ORCH_TIMEOUT.kill });
  if (r.status < 400) auditAdmin({ actor: gate.user.id, action: "kill", target: `session:${id}` });
  return NextResponse.json(r.body, { status: r.status });
}
