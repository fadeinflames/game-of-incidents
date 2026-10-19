// upsertImportRecord against a recording stub: what goes into the upsert decides what a re-import changes.
import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { upsertImportRecord } from "@wom/db/import";
import type { ImportRecord } from "@wom/scenario";

function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return {
    slug: "demo",
    schemaVersion: 2,
    title: "Demo",
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

function stub() {
  const upsert = vi.fn(async (args: { create: { slug: string } }) => ({ id: "row", slug: args.create.slug }));
  const updateMany = vi.fn(async () => ({ count: 0 }));
  return { prisma: { scenario: { upsert, updateMany } } as unknown as PrismaClient, upsert, updateMany };
}

describe("upsertImportRecord", () => {
  it("a re-import without environment and gm script clears what the previous version stored", async () => {
    const { prisma, upsert } = stub();
    await upsertImportRecord(prisma, record());
    const { update, create } = upsert.mock.calls[0][0] as unknown as { update: Record<string, unknown>; create: Record<string, unknown> };
    // undefined would mean "leave the column as it is": the orchestrator would go on starting a stand that is gone
    expect(update.environmentJson).toBe(Prisma.DbNull);
    expect(update.gmScriptJson).toBe(Prisma.DbNull);
    expect(create.environmentJson).toBe(Prisma.DbNull);
  });

  it("keeps the environment and the gm script when the record has them", async () => {
    const { prisma, upsert } = stub();
    const environmentJson = { image: "wom-scenario/demo:1", ttlMin: 30 };
    await upsertImportRecord(prisma, record({ environmentJson: environmentJson as never, gmScriptJson: { a: 1 } as never }));
    const { update } = upsert.mock.calls[0][0] as unknown as { update: Record<string, unknown> };
    expect(update.environmentJson).toEqual(environmentJson);
    expect(update.gmScriptJson).toEqual({ a: 1 });
  });

  it("writes the source only when it is given, so an admin import never takes a row over from the seed", async () => {
    const { prisma, upsert } = stub();
    await upsertImportRecord(prisma, record());
    expect((upsert.mock.calls[0][0] as unknown as { update: Record<string, unknown> }).update).not.toHaveProperty("source");
    await upsertImportRecord(prisma, record(), { source: "seed" });
    expect((upsert.mock.calls[1][0] as unknown as { update: Record<string, unknown> }).update.source).toBe("seed");
  });
});
