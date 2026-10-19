// Moderation: download the submitted zip as is, to read it before running anything from it.
import { NextResponse } from "next/server";
import { prisma } from "@wom/db";
import { requireAdminApi } from "@/lib/admin";
import { notFound } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await requireAdminApi();
  if ("response" in gate) return gate.response;
  const { id } = await ctx.params;
  const sub = await prisma.scenarioSubmission.findUnique({ where: { id }, select: { id: true, slug: true, archive: true } });
  if (!sub) return notFound("Заявка не найдена");

  // the retention job empties the archive of old finished submissions
  if (sub.archive.byteLength === 0) return NextResponse.json({ error: "Архив заявки удалён по сроку хранения" }, { status: 410 });

  const name = `${sub.slug}-${sub.id}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new NextResponse(new Uint8Array(sub.archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Content-Length": String(sub.archive.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
