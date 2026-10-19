// ImportRecord (packages/scenario) -> Scenario rows. Shared by the seed, POST /api/import and moderation approve.
// A record with guideMd becomes TWO rows: the regular copy and the "<slug>-tutorial" teaching copy (owner decision 2026-09-30).
import type { PrismaClient } from "@prisma/client";
// a value import: Prisma.DbNull is a runtime object
import { Difficulty, Prisma } from "@prisma/client";
import { importVariants, TUTORIAL_SUFFIX, validateImportRecord, type ImportRecord } from "@wom/scenario";

export type ImportExtra = {
  authorId?: string | null;
  isPublished?: boolean;
  /** who created the row; the seed passes "seed" so it can later unpublish the ones that left the repository */
  source?: string;
};

function rowData(r: ImportRecord, extra: ImportExtra) {
  return {
    slug: r.slug,
    schemaVersion: r.schemaVersion,
    title: r.title,
    summary: r.summary,
    type: r.type,
    difficulty: Difficulty[r.difficulty],
    durationMin: r.durationMin,
    tags: r.tags,
    contextJson: r.contextJson as Prisma.InputJsonValue,
    eventsJson: r.eventsJson as Prisma.InputJsonValue,
    hintsJson: r.hintsJson as Prisma.InputJsonValue,
    actionsJson: r.actionsJson as Prisma.InputJsonValue,
    // undefined in an update means "leave as it is": a re-import without these fields has to clear them
    gmScriptJson: (r.gmScriptJson ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    briefMd: r.briefMd,
    debriefMd: r.debriefMd,
    guideMd: r.guideMd ?? null,
    environmentJson: (r.environmentJson ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    breakScript: r.breakScript,
    graderScript: r.graderScript,
    solutionScript: r.solutionScript,
    ...(extra.authorId !== undefined ? { authorId: extra.authorId } : {}),
    ...(extra.isPublished !== undefined ? { isPublished: extra.isPublished } : {}),
    ...(extra.source !== undefined ? { source: extra.source } : {}),
  };
}

/** upserts the regular copy (returned) and, when the record has a guide, the teaching copy; a stale teaching copy is unpublished */
export async function upsertImportRecord(prisma: PrismaClient, r: ImportRecord, extra: ImportExtra = {}) {
  // the one gate in front of the table for the seed, /api/import and moderation approve; throws ImportRecordError
  validateImportRecord(r);
  const { regular, tutorial } = importVariants(r);
  const base = rowData(regular, extra);
  const row = await prisma.scenario.upsert({ where: { slug: regular.slug }, update: base, create: base });
  const tutorialSlug = regular.slug + TUTORIAL_SUFFIX;
  if (tutorial) {
    const data = rowData(tutorial, extra);
    await prisma.scenario.upsert({ where: { slug: tutorialSlug }, update: data, create: data });
  } else {
    await prisma.scenario.updateMany({ where: { slug: tutorialSlug }, data: { isPublished: false } });
  }
  return row;
}
