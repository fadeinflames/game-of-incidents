import { describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "../src/docker";
import { IMMUTABLE_PREFIXES, isImmutablePath, type SandboxSpec } from "../src/types";

const spec = (over: Partial<SandboxSpec>): SandboxSpec => ({
  image: "x",
  writable: [],
  tmpfs: {},
  capAdd: [],
  sudo: false,
  resources: { cpus: 1, memoryMb: 64, pids: 16 },
  labels: {},
  ...over,
});

describe("R-4: system directories stay read-only", () => {
  it("knows the prefixes and their children, not look-alikes", () => {
    expect(isImmutablePath("/usr")).toBe(true);
    expect(isImmutablePath("/usr/local/bin")).toBe(true);
    expect(isImmutablePath("/lib64")).toBe(true);
    expect(isImmutablePath("/usrx")).toBe(false);
    expect(isImmutablePath("/var/lib")).toBe(false);
    expect(isImmutablePath("/etc")).toBe(false);
  });

  it.each([
    ["writable", { writable: ["/usr/bin"] }],
    ["writable with a trailing path", { writable: ["/bin/sh"] }],
    ["tmpfs", { tmpfs: { "/sbin": "size=1m" } }],
    ["relative path", { writable: ["etc"] }],
    ["parent segment", { writable: ["/var/../usr"] }],
  ])("create() refuses a %s over the binaries before it talks to Docker", async (_label, over) => {
    const provider = new DockerRuntimeProvider("/nonexistent.sock");
    await expect(provider.create(spec(over as Partial<SandboxSpec>))).rejects.toThrow(/cannot be writable or a tmpfs/);
  });

  it("the list is not empty", () => {
    expect(IMMUTABLE_PREFIXES.length).toBeGreaterThan(5);
  });
});
