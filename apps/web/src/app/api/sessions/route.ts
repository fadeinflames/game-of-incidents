import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, crossOriginResponse, readJson, tooMany, unauthorized } from "@/lib/http";
import { ORCH_TIMEOUT, orchestrator } from "@/lib/orchestrator";
import { clientKeyFromRequest, publicClientIp, rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  // per-IP limiter on session creation
  const gate = rateLimit(clientKeyFromRequest(req, "session-create"), { limit: 6, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterMs, "Слишком много запусков подряд.");
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const json = await readJson<{ scenarioId?: string }>(req, { maxBytes: 16 * 1024 });
  if (!json.ok) return json.response;
  const scenarioId = json.data.scenarioId;
  if (typeof scenarioId !== "string" || scenarioId.length < 10) return badRequest("Не указан сценарий");

  // the orchestrator caps active stands per address (MAX_SESSIONS_PER_IP); no address = no per-IP cap
  const clientIp = publicClientIp(req) ?? undefined;
  const r = await orchestrator("/sessions", { method: "POST", body: { userId: user.id, scenarioId, clientIp }, timeoutMs: ORCH_TIMEOUT.create });
  return NextResponse.json(r.body, { status: r.status });
}
