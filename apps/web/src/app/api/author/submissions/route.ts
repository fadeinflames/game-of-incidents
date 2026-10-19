// Author cabinet: upload a scenario folder as a zip. Static checks only here (unzip, schema, lint); build and regression
// run later, when a moderator asks (untrusted Dockerfiles must not build automatically on the platform host).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma, SubmissionStatus, type Prisma } from "@wom/db";
import { ArchiveError, ScenarioLoadError, ZIP_MAX_BYTES, extractScenarioZip, importRecordSchema, lintBundle, loadScenarioFolder, toImportRecord } from "@wom/scenario";
import { getCurrentUser } from "@/lib/auth";
import { crossOriginResponse, readBodyCapped, tooLarge, tooMany, unauthorized } from "@/lib/http";
import { clientKeyFromRequest, rateLimit } from "@/lib/rate-limit";
import { MAX_SUBMISSIONS, storeSubmission } from "@/lib/submissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// the multipart envelope around the zip: field names, boundaries, file name
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const publicFields = {
  id: true,
  slug: true,
  title: true,
  status: true,
  lintReport: true,
  testReport: true,
  moderatorNote: true,
  scenarioId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const items = await prisma.scenarioSubmission.findMany({ where: { authorId: user.id }, orderBy: { createdAt: "desc" }, take: MAX_SUBMISSIONS, select: publicFields });
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  const gate = rateLimit(clientKeyFromRequest(req, "submission-upload"), { limit: 3, windowMs: 60_000 });
  if (!gate.ok) return tooMany(gate.retryAfterMs, "Слишком много загрузок подряд.");
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  // never buffer more than the limit: formData() would read a body of any size into memory first
  const body = await readBodyCapped(req, ZIP_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
  if (!body) return tooLarge(`Архив больше ${ZIP_MAX_BYTES / 1024 / 1024} МБ`);
  const form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData().catch(() => null);
  const file = form?.get("archive");
  if (!(file instanceof File)) return NextResponse.json({ error: "Нужен zip-архив в поле archive" }, { status: 400 });
  if (file.size > ZIP_MAX_BYTES) return tooLarge(`Архив больше ${ZIP_MAX_BYTES / 1024 / 1024} МБ`);
  const zip = new Uint8Array(await file.arrayBuffer());

  const tmp = mkdtempSync(path.join(os.tmpdir(), "wom-sub-"));
  try {
    const extracted = extractScenarioZip(zip, tmp);
    const bundle = loadScenarioFolder(extracted.dir);
    const issues = lintBundle(bundle);
    const record = toImportRecord(bundle);
    // the same gate approve passes through: a record the database would refuse must not wait in the queue as UPLOADED
    const recordCheck = importRecordSchema.safeParse(record);
    if (!recordCheck.success) {
      const first = recordCheck.error.issues[0];
      issues.push({ level: "error", rule: "import-record", message: `${first?.path.join(".") || "(root)"}: ${first?.message}` });
    }
    const errors = issues.filter((i) => i.level === "error");

    const stored = await storeSubmission(user.id, {
      slug: record.slug,
      title: record.title,
      status: errors.length ? SubmissionStatus.LINT_FAILED : SubmissionStatus.UPLOADED,
      archive: Buffer.from(zip),
      record: record as unknown as Prisma.InputJsonValue,
      lintReport: issues as unknown as Prisma.InputJsonValue,
    });
    if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: stored.status });
    const sub = await prisma.scenarioSubmission.findUnique({ where: { id: stored.id }, select: publicFields });
    return NextResponse.json(sub, { status: 201 });
  } catch (err) {
    if (err instanceof ArchiveError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof ScenarioLoadError) return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
    // a path from scenario.yaml is a folder in the archive, not a file
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EISDIR") {
      return NextResponse.json({ error: "В архиве вместо файла из scenario.yaml лежит папка" }, { status: 400 });
    }
    throw err;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
