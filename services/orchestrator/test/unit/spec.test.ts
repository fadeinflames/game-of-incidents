import { describe, expect, it } from "vitest";
import { specFromEnvironment } from "../../src/sessions";
import { DEFAULT_CAPS, DEFAULT_WRITABLE, SESSION_LABEL } from "@wom/runtime";

describe("specFromEnvironment", () => {
  it("applies hardening defaults and labels the sandbox with the session id", () => {
    const spec = specFromEnvironment({ image: "img" }, "sess-1");
    expect(spec.capAdd).toEqual(DEFAULT_CAPS);
    expect(spec.writable).toEqual(DEFAULT_WRITABLE);
    expect(spec.sudo).toBe(false);
    expect(spec.resources).toEqual({ cpus: 1, memoryMb: 512, pids: 256 });
    expect(spec.labels[SESSION_LABEL]).toBe("sess-1");
  });

  it("honours scenario overrides", () => {
    const spec = specFromEnvironment(
      { image: "img", hostname: "web-01", writable: ["/etc"], shell: { sudo: true }, resources: { memoryMb: 128 } },
      "s",
    );
    expect(spec.hostname).toBe("web-01");
    expect(spec.writable).toEqual(["/etc"]);
    expect(spec.sudo).toBe(true);
    expect(spec.resources.memoryMb).toBe(128);
  });

  it("rejects unsupported kinds and missing images", () => {
    expect(() => specFromEnvironment({ kind: "compose", image: "x" }, "s")).toThrow(/not supported/);
    expect(() => specFromEnvironment({ image: "" }, "s")).toThrow(/image/);
  });
});
