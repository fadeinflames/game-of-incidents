import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_IMAGE, NODE_IMAGE_RE, parseEnvironment, shellFromEnvironment, specFromEnvironment, type Environment } from "../src";

describe("parseEnvironment: the one way a stored environmentJson becomes an Environment", () => {
  it("accepts the shapes the loader writes", () => {
    expect(parseEnvironment({ image: "wom-scenario/x:1" })).toEqual({ image: "wom-scenario/x:1" });
    expect(parseEnvironment({ kind: "kubernetes", image: "wom-tools:dev", manifests: [] }).kind).toBe("kubernetes");
    expect(parseEnvironment({ kind: "container", image: "x" }).kind).toBe("container");
  });

  it.each([
    ["null", null],
    ["a string", "docker"],
    ["an array", [{ image: "x" }]],
    ["a kind nobody knows", { kind: "vm", image: "x" }],
    ["no image", { kind: "kubernetes" }],
    ["an empty image", { image: "" }],
    ["a numeric image", { image: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseEnvironment(value)).toThrow();
  });
});

describe("specFromEnvironment", () => {
  it("a container environment never gets a kubernetes block, even if the stored JSON carries kubernetes fields", () => {
    const env = { image: "x", cluster: { nodes: 3 }, manifests: [{ name: "a", content: "b" }], images: ["y"] } as Environment;
    expect(specFromEnvironment(env, "s").kubernetes).toBeUndefined();
  });

  it("a kubernetes environment gets the default node image and one node", () => {
    const spec = specFromEnvironment({ kind: "kubernetes", image: "wom-tools:dev" }, "s");
    expect(spec.kubernetes).toEqual({ nodes: 1, nodeImage: DEFAULT_NODE_IMAGE, workerLabels: undefined, manifests: [], images: [] });
    expect(NODE_IMAGE_RE.test(DEFAULT_NODE_IMAGE)).toBe(true);
  });

  it("refuses a kind the runtime has no provider for, whatever the type says", () => {
    expect(() => specFromEnvironment({ kind: "compose", image: "x" }, "s")).toThrow(/not supported/);
    expect(() => specFromEnvironment({ kind: "vm", image: "x" } as unknown as Environment, "s")).toThrow(/not supported/);
  });

  it("extra labels (the CLI sets its own owner) override the owner and keep the session label", () => {
    const spec = specFromEnvironment({ image: "x" }, "s", { "wom.owner": "cli" });
    expect(spec.labels).toMatchObject({ "wom.session": "s", "wom.owner": "cli" });
  });
});

describe("shellFromEnvironment", () => {
  it("defaults to root in /bin/sh at /", () => {
    expect(shellFromEnvironment({})).toEqual({ user: "root", shell: "/bin/sh", cwd: "/" });
    expect(shellFromEnvironment({ shell: { user: "oncall", cwd: "/home/oncall" } })).toEqual({ user: "oncall", shell: "/bin/sh", cwd: "/home/oncall" });
  });
});
