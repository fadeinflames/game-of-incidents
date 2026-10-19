import { SessionStatus } from "@wom/db";
import { describe, expect, it } from "vitest";
import { ACTIVE_SESSION_STATUSES, FINAL_SESSION_STATUSES, SESSION_STATUS } from "@/lib/labels";

describe("session status sets", () => {
  it("split every status of the schema into active and final, with no overlap", () => {
    const all = Object.values(SessionStatus).sort();
    expect([...ACTIVE_SESSION_STATUSES, ...FINAL_SESSION_STATUSES].sort()).toEqual(all);
  });

  it("have a label for every status", () => {
    expect(Object.keys(SESSION_STATUS).sort()).toEqual(Object.values(SessionStatus).sort());
  });
});
