import { describe, expect, it } from "vitest";
import { IMMUTABLE_PREFIXES as RUNTIME } from "@wom/runtime";
import { IMMUTABLE_PREFIXES as SCHEMA } from "../src/schema";

describe("R-4 prefixes", () => {
  it("the schema (uploads) and the runtime (sandboxes) forbid the same directories", () => {
    expect([...SCHEMA].sort()).toEqual([...RUNTIME].sort());
  });
});
