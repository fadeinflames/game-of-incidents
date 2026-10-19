// Admin: publish / unpublish a scenario (its teaching copy follows).
import { NextResponse } from "next/server";
import { prisma } from "@wom/db";
import { TUTORIAL_SUFFIX } from "@wom/scenario";
import { requireAdminApi } from "@/lib/admin";
import { auditAdmin } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/http";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await requireAdminApi(req);
  if ("response" in gate) return gate.response;
  const { id, action } = await ctx.params;
  if (action !== "publish" && action !== "unpublish") return badRequest("Неизвестное действие");
  const scenario = await prisma.scenario.findUnique({ where: { id }, select: { id: true, slug: true } });
  if (!scenario) return notFound("Сценарий не найден");
  const isPublished = action === "publish";
  const slugs = scenario.slug.endsWith(TUTORIAL_SUFFIX) ? [scenario.slug] : [scenario.slug, scenario.slug + TUTORIAL_SUFFIX];
  const r = await prisma.scenario.updateMany({ where: { slug: { in: slugs } }, data: { isPublished } });
  auditAdmin({ actor: gate.user.id, action, target: `scenario:${id}` });
  return NextResponse.json({ ok: true, isPublished, updated: r.count });
}
