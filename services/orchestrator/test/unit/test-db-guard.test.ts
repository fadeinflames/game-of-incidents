import { describe, expect, it } from "vitest";
import { assertTestDatabase } from "../setup/guard";

describe("assertTestDatabase", () => {
  it.each([
    "postgresql://wom:secret@localhost:5432/wom_test",
    "postgresql://wom:secret@localhost:5432/WOM_TEST?schema=public",
    "postgresql://wom:secret@db/test",
  ])("accepts %s", (url) => {
    expect(() => assertTestDatabase(url, {})).not.toThrow();
  });

  it.each(["postgresql://wom:secret@db:5432/wom", "postgresql://wom:secret@db:5432/wom?schema=test", "postgresql://wom:secret@db:5432/"])(
    "refuses %s unless the operator allows any database",
    (url) => {
      expect(() => assertTestDatabase(url, {})).toThrow(/does not look like a test database/);
      expect(() => assertTestDatabase(url, { WOM_TEST_ALLOW_ANY_DB: "0" })).toThrow();
      expect(() => assertTestDatabase(url, { WOM_TEST_ALLOW_ANY_DB: "1" })).not.toThrow();
    },
  );

  it("does not leak the password or the host into the message", () => {
    try {
      assertTestDatabase("postgresql://wom:hunter2@prod-host:5432/wom", {});
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('"wom"');
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("prod-host");
    }
  });
});
