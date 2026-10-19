import { describe, expect, it } from "vitest";
import { databasePool } from "../../src/db-pool";

describe("databasePool", () => {
  it("reads the pool parameters from the URL", () => {
    expect(databasePool("postgresql://wom:secret@db:5432/wom?schema=public&connection_limit=10&pool_timeout=20&connect_timeout=10")).toEqual({ connectionLimit: 10, poolTimeoutSec: 20 });
  });

  it("null where the URL says nothing (the Prisma default applies) or something that is not a number", () => {
    expect(databasePool("postgresql://wom:wom@127.0.0.1:5433/wom?schema=public")).toEqual({ connectionLimit: null, poolTimeoutSec: null });
    expect(databasePool("postgresql://wom:wom@db/wom?connection_limit=ten&pool_timeout=0")).toEqual({ connectionLimit: null, poolTimeoutSec: null });
    expect(databasePool(undefined)).toEqual({ connectionLimit: null, poolTimeoutSec: null });
  });

  it("never hands the URL (and the password in it) back", () => {
    expect(JSON.stringify(databasePool("postgresql://wom:hunter2@db/wom?connection_limit=5"))).not.toContain("hunter2");
  });
});
