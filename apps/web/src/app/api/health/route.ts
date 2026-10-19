// GET /api/health — liveness for Caddy/external checks: DB reachable and orchestrator answering.
// checks.disk (used %, integer) and checks.egress ("ok" | "stale" | "off") are relayed from the orchestrator for
// deploy/healthcheck.sh; they do not affect `ok` (a full disk is an alert, not an outage of the site itself).
import { NextResponse } from "next/server";
import { prisma } from "@wom/db";

export const dynamic = "force-dynamic";

type OrchestratorHealth = { ok?: unknown; degraded?: unknown; disk?: { usedPct?: unknown }; egress?: unknown };

export async function GET() {
  const checks: { db: boolean; orchestrator: boolean; disk: number | null; egress: string | null } = { db: false, orchestrator: false, disk: null, egress: null };
  // what the orchestrator itself reports as wrong while it still answers (docker down, reconciler stalled, a run of FAILED sessions)
  let degraded: string[] = [];
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {
    // reported below
  }
  try {
    const r = await fetch(`${process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3080"}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    checks.orchestrator = r.ok;
    const body = (await r.json().catch(() => null)) as OrchestratorHealth | null;
    const usedPct = body?.disk?.usedPct;
    if (typeof usedPct === "number" && Number.isFinite(usedPct)) checks.disk = Math.floor(usedPct);
    if (body?.egress === "ok" || body?.egress === "stale" || body?.egress === "off") checks.egress = body.egress;
    if (Array.isArray(body?.degraded)) degraded = body.degraded.filter((d): d is string => typeof d === "string").slice(0, 10);
    else if (body?.ok === false) degraded = ["orchestrator"];
  } catch {
    // reported below
  }
  const ok = checks.db && checks.orchestrator;
  // `degraded` does not turn `ok` off: the site works, an operator has to look (deploy/healthcheck.sh raises a warning)
  return NextResponse.json({ ok, checks, degraded }, { status: ok ? 200 : 503 });
}
