// Author cabinet: the scenario-authoring guide (agent skill) as a download while the repository is private.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// cwd is apps/web both under `next dev` and in the standalone image (server.js chdirs to its own directory),
// so the repository root is two levels up
const SKILL_FILE = path.resolve(process.cwd(), "../..", "agent-skill/wom-scenario-author/SKILL.md");

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  let text: string;
  try {
    text = await readFile(SKILL_FILE, "utf8");
  } catch {
    return NextResponse.json({ error: "Файл руководства недоступен на сервере. Напиши администратору." }, { status: 503 });
  }
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="SKILL.md"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
