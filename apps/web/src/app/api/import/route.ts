// POST /api/import — accepts the v1 file (wom-games, text-only) or the v2 file produced by `wom scenario export`.
// Admin only: scenarios are global on this platform (no user packs in slice 2).
import { NextResponse } from "next/server";
import { prisma, type PrismaClient } from "@wom/db";
import { upsertImportRecord } from "@wom/db/import";
import { ImportRecordError, importFileV1Schema, importFileV2Schema, v1Overwrites, v1ToImportRecord, type ImportRecord } from "@wom/scenario";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, crossOriginResponse, readJson, unauthorized } from "@/lib/http";

export async function POST(req: Request) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return NextResponse.json({ error: "Только для администратора" }, { status: 403 });

  const json = await readJson<{ version?: unknown }>(req, { maxBytes: 4 * 1024 * 1024 });
  if (!json.ok) return json.response;

  let records: ImportRecord[];
  if (json.data.version === 2) {
    const parsed = importFileV2Schema.safeParse(json.data);
    if (!parsed.success) return badRequest(`invalid v2 import: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    records = parsed.data.scenarios;
  } else {
    const parsed = importFileV1Schema.safeParse(json.data);
    if (!parsed.success) return badRequest(`invalid v1 import: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    records = parsed.data.scenarios.map(v1ToImportRecord);
  }

  // all or nothing: a file that fails halfway must not leave half of its scenarios published
  try {
    const slugs = await prisma.$transaction(
      async (tx) => {
        // a v1 file derives its slugs from titles: it must not replace a live v2 scenario that happens to slug the same
        const existing = await tx.scenario.findMany({ where: { slug: { in: records.map((r) => r.slug) } }, select: { slug: true, schemaVersion: true } });
        const clash = v1Overwrites(records, existing);
        if (clash.length) throw new V1Overwrite(clash);
        const done: string[] = [];
        for (const r of records) done.push((await upsertImportRecord(tx as unknown as PrismaClient, r)).slug);
        return done;
      },
      { timeout: 60_000 },
    );
    return NextResponse.json({ ok: true, count: slugs.length, slugs });
  } catch (err) {
    if (err instanceof V1Overwrite) return NextResponse.json({ error: `v1-файл заменил бы живые сценарии: ${err.slugs.join(", ")}. Переименуй их в файле или загрузи v2` }, { status: 409 });
    if (err instanceof ImportRecordError) return badRequest(`invalid import record: ${err.issues[0]}`);
    throw err;
  }
}

class V1Overwrite extends Error {
  constructor(public slugs: string[]) {
    super("v1 import would overwrite a v2 scenario");
  }
}
