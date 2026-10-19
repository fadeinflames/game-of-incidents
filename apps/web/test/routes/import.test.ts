import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const db = vi.hoisted(() => {
  const tx = { scenario: { findMany: vi.fn() } };
  return { tx, prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } };
});
const upsert = vi.hoisted(() => ({ upsertImportRecord: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@wom/db", () => ({ prisma: db.prisma }));
vi.mock("@wom/db/import", () => upsert);

import { ImportRecordError } from "@wom/scenario";
import { POST } from "@/app/api/import/route";
import { jsonRequest } from "./helpers";

const v1 = { version: 1, scenarios: [{ title: "Cert expired", summary: "A certificate expired overnight", type: "tls" }] };

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUser.mockResolvedValue({ id: "admin1", username: "root", email: null, role: "admin" });
  db.tx.scenario.findMany.mockResolvedValue([]);
  upsert.upsertImportRecord.mockImplementation(async (_p: unknown, r: { slug: string }) => ({ slug: r.slug }));
});

describe("POST /api/import", () => {
  it("imports a v1 file under a new slug", async () => {
    const res = await POST(jsonRequest("/api/import", v1));
    expect(res.status).toBe(200);
    expect(upsert.upsertImportRecord).toHaveBeenCalledTimes(1);
  });

  it("answers 409 and writes nothing when a v1 file would replace a live v2 scenario", async () => {
    db.tx.scenario.findMany.mockResolvedValue([{ slug: "cert-expired", schemaVersion: 2 }]);
    const res = await POST(jsonRequest("/api/import", v1));
    expect(res.status).toBe(409);
    expect(upsert.upsertImportRecord).not.toHaveBeenCalled();
  });

  it("answers 400, not 500, when the database gate refuses a record", async () => {
    upsert.upsertImportRecord.mockRejectedValue(new ImportRecordError(["environmentJson.writable.0: nope"]));
    const res = await POST(jsonRequest("/api/import", v1));
    expect(res.status).toBe(400);
  });
});
