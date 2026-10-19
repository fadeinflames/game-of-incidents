// upsertImportRecord against the real database: what a re-import leaves behind.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@wom/db";
import { upsertImportRecord } from "@wom/db/import";
import type { ImportRecord } from "@wom/scenario";

const hasDb = Boolean(process.env.DATABASE_URL);
const prisma = new PrismaClient();
const SLUG = "test-import-clears";

function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return {
    slug: SLUG,
    schemaVersion: 2,
    title: "Import test",
    summary: "A short summary of the case.",
    type: "linux",
    difficulty: "MIDDLE",
    durationMin: 20,
    tags: [],
    contextJson: {},
    eventsJson: [],
    hintsJson: [],
    actionsJson: [],
    gmScriptJson: null,
    briefMd: null,
    debriefMd: null,
    guideMd: null,
    environmentJson: null,
    breakScript: null,
    graderScript: null,
    solutionScript: null,
    ...over,
  } as ImportRecord;
}

describe.skipIf(!hasDb)("upsertImportRecord (integration)", () => {
  afterAll(async () => {
    await prisma.scenario.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
  });

  it("a re-import without environment and gm script clears the old ones, so no stand is started for a scenario that no longer has one", async () => {
    await upsertImportRecord(prisma, record({ environmentJson: { image: "wom-scenario/x:1", ttlMin: 30 } as never, gmScriptJson: { a: 1 } as never }), { isPublished: false });
    const first = await prisma.scenario.findUnique({ where: { slug: SLUG } });
    expect(first!.environmentJson).not.toBeNull();
    expect(first!.gmScriptJson).not.toBeNull();
    await upsertImportRecord(prisma, record(), { isPublished: false });
    const second = await prisma.scenario.findUnique({ where: { slug: SLUG } });
    expect(second!.environmentJson).toBeNull();
    expect(second!.gmScriptJson).toBeNull();
  });

  it("the source is recorded when given and survives an import that does not give it", async () => {
    await upsertImportRecord(prisma, record(), { isPublished: false, source: "seed" });
    await upsertImportRecord(prisma, record({ title: "Import test v2" }), { isPublished: false });
    const row = await prisma.scenario.findUnique({ where: { slug: SLUG } });
    expect(row!.title).toBe("Import test v2");
    expect(row!.source).toBe("seed");
  });
});
