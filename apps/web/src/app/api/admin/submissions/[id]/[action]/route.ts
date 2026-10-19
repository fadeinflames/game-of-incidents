// Moderation: test (build + regression on the orchestrator), approve (publish as a Scenario), reject (with a note).
import { NextResponse } from "next/server";
import { prisma, SubmissionStatus, type PrismaClient } from "@wom/db";
import { upsertImportRecord } from "@wom/db/import";
import { ImportRecordError, type ImportRecord } from "@wom/scenario";
import { requireAdminApi } from "@/lib/admin";
import { auditAdmin } from "@/lib/audit";
import { badRequest, readJson } from "@/lib/http";
import { orchestrator } from "@/lib/orchestrator";
import { scenarioSlugs } from "@/lib/submissions";

type Ctx = { params: Promise<{ id: string; action: string }> };

const ACTIONS = ["test", "approve", "reject"];

export async function POST(req: Request, ctx: Ctx) {
  const gate = await requireAdminApi(req);
  if ("response" in gate) return gate.response;
  const { id, action } = await ctx.params;
  if (!ACTIONS.includes(action)) return badRequest("Неизвестное действие");
  const sub = await prisma.scenarioSubmission.findUnique({ where: { id } });
  if (!sub) return NextResponse.json({ error: "Заявка не найдена" }, { status: 404 });
  const audit = () => auditAdmin({ actor: gate.user.id, action, target: `submission:${id}` });

  if (action === "test") {
    const testable: SubmissionStatus[] = [SubmissionStatus.UPLOADED, SubmissionStatus.PASSED, SubmissionStatus.FAILED];
    if (!testable.includes(sub.status)) {
      return badRequest(`Нельзя проверять заявку в статусе ${sub.status}`);
    }
    const r = await orchestrator(`/submissions/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
    if (r.status < 400) audit();
    return NextResponse.json(r.body, { status: r.status });
  }

  if (action === "approve") {
    if (sub.status !== SubmissionStatus.PASSED) return badRequest("Публиковать можно только заявку, прошедшую проверку (PASSED)");
    const record = sub.record as unknown as ImportRecord | null;
    if (!record) return badRequest("У заявки нет данных сценария");

    // The slug was checked at upload, but a scenario of another author may have been published since, and upsert would
    // overwrite its content, scripts and authorId. The check and the publication share a transaction; the advisory
    // lock makes two approvals of one slug wait for each other.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"slug:" + record.slug}))`;
      const owners = await tx.scenario.findMany({ where: { slug: { in: scenarioSlugs(record.slug) } }, select: { authorId: true } });
      if (owners.some((o) => o.authorId !== sub.authorId)) return null;
      // the helper only touches the scenario table, which a transaction client has as well
      const scenario = await upsertImportRecord(tx as unknown as PrismaClient, record, { authorId: sub.authorId, isPublished: true });
      const claimed = await tx.scenarioSubmission.updateMany({
        where: { id, status: SubmissionStatus.PASSED },
        data: { status: SubmissionStatus.APPROVED, scenarioId: scenario.id, moderatorNote: null },
      });
      if (claimed.count !== 1) throw new StaleSubmission();
      return { id, status: SubmissionStatus.APPROVED, scenarioId: scenario.id };
    }).catch((err) => {
      if (err instanceof StaleSubmission) return "stale" as const;
      if (err instanceof ImportRecordError) return err;
      throw err;
    });
    if (updated instanceof ImportRecordError) return NextResponse.json({ error: `Сценарий не проходит проверку формата: ${updated.issues[0] ?? "ошибка записи"}` }, { status: 422 });
    if (updated === null) return NextResponse.json({ error: `slug «${sub.slug}» уже принадлежит другому автору, публикация отменена` }, { status: 409 });
    if (updated === "stale") return NextResponse.json({ error: "Статус заявки изменился, обнови страницу" }, { status: 409 });
    audit();
    return NextResponse.json(updated);
  }

  // reject
  if (sub.status === SubmissionStatus.TESTING) return badRequest("Заявка сейчас проверяется, дождись результата");
  if (sub.status === SubmissionStatus.REJECTED) return badRequest("Заявка уже отклонена");
  const json = await readJson<{ note?: string }>(req, { maxBytes: 16 * 1024 });
  if (!json.ok) return json.response;
  const note = typeof json.data.note === "string" ? json.data.note.trim().slice(0, 2000) : "";
  if (!note) return badRequest("Нужен комментарий автору");
  const updated = await prisma.$transaction(async (tx) => {
    // rejecting what is already published takes it down together with its teaching copy (only the author's own rows)
    if (sub.status === SubmissionStatus.APPROVED) {
      await tx.scenario.updateMany({ where: { slug: { in: scenarioSlugs(sub.slug) }, authorId: sub.authorId }, data: { isPublished: false } });
    }
    return tx.scenarioSubmission.update({ where: { id }, data: { status: SubmissionStatus.REJECTED, moderatorNote: note }, select: { id: true, status: true } });
  });
  audit();
  return NextResponse.json(updated);
}

class StaleSubmission extends Error {}
