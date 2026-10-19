import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLevel, serializeError } from "../../src/logger";

describe("config", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("parseNum takes a number, falls back for an unset value and refuses a typo", async () => {
    vi.stubEnv("INTERNAL_TOKEN", "t");
    const { parseNum } = await import("../../src/config");
    expect(parseNum("X", "15", 1)).toBe(15);
    expect(parseNum("X", "0", 1)).toBe(0);
    expect(parseNum("X", undefined, 7)).toBe(7);
    expect(parseNum("X", "", 7)).toBe(7);
    for (const bad of ["2O", "5m", "NaN", "-1", "Infinity"]) expect(() => parseNum("X", bad, 1)).toThrow(/Invalid env X/);
  });

  it("the module refuses to load with a broken numeric variable", async () => {
    vi.stubEnv("INTERNAL_TOKEN", "t");
    vi.stubEnv("MAX_SESSIONS_GLOBAL", "1O");
    await expect(import("../../src/config")).rejects.toThrow(/MAX_SESSIONS_GLOBAL/);
  });

  it("the logged configuration never carries the internal token", async () => {
    vi.stubEnv("INTERNAL_TOKEN", "super-secret");
    const { loggableConfig } = await import("../../src/config");
    const shown = loggableConfig();
    expect(JSON.stringify(shown)).not.toContain("super-secret");
    expect(shown).toHaveProperty("maxSessionsGlobal");
  });
});

describe("logger", () => {
  it("parseLevel ignores case and falls back to info", () => {
    expect(parseLevel("DEBUG")).toBe("debug");
    expect(parseLevel(" Warn ")).toBe("warn");
    expect(parseLevel("warning")).toBe("warn");
    expect(parseLevel(undefined)).toBe("info");
    expect(parseLevel("verbose")).toBe("info");
    expect(parseLevel("constructor")).toBe("info");
  });

  it("serializeError keeps its own fields and the cause chain", () => {
    const inner = new Error("ECONNREFUSED");
    const err = Object.assign(new Error("docker ping failed", { cause: inner }), { code: "E_PING" });
    const out = serializeError(err) as { message: string; code: string; cause: { message: string } };
    expect(out.message).toBe("docker ping failed");
    expect(out.code).toBe("E_PING");
    expect(out.cause.message).toBe("ECONNREFUSED");
  });
});
