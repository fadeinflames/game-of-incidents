import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NODE_IMAGE, KubernetesRuntimeProvider, kindConfig, kindNodeLimits, type DockerRuntimeProvider } from "../src";

const INJECTED = "extraMounts";

describe("kindConfig", () => {
  it("writes the node image as a quoted scalar on every node", () => {
    const lines = kindConfig(3, DEFAULT_NODE_IMAGE).split("\n");
    expect(lines.filter((l) => l.startsWith("    image: "))).toEqual(Array(3).fill(`    image: "${DEFAULT_NODE_IMAGE}"`));
    expect(lines.filter((l) => l.startsWith("  - role: "))).toEqual(["  - role: control-plane", "  - role: worker", "  - role: worker"]);
  });

  it("accepts a digest-pinned kindest/node image", () => {
    const pinned = `kindest/node:v1.37.0@sha256:${"a".repeat(64)}`;
    expect(kindConfig(1, pinned)).toContain(`    image: "${pinned}"`);
  });

  it.each([
    ["line feed", `kindest/node:v1.37.0\n    ${INJECTED}:\n      - hostPath: /home/wom\n        containerPath: /host`],
    ["trailing line feed", "kindest/node:v1.37.0\n"],
    ["carriage return", `kindest/node:v1.37.0\r    ${INJECTED}: []`],
    ["quotes", `kindest/node:v1.37.0", ${INJECTED}: "x`],
    ["flow mapping", `{ image: kindest/node:v1.37.0, ${INJECTED}: [] }`],
    ["another repository", "evil.example/node:v1.37.0"],
    ["a tag that is not a version", "kindest/node:latest"],
    ["an empty string", ""],
  ])("rejects a node image with %s", (_name, image) => {
    expect(() => kindConfig(2, image)).toThrow(/nodeImage/);
  });

  it("keeps line feeds and quotes in worker labels inside one quoted scalar", () => {
    const key = `zone"\n    ${INJECTED}`;
    const value = `a"\n    ${INJECTED}:\n      - hostPath: /`;
    const out = kindConfig(2, DEFAULT_NODE_IMAGE, [{ [key]: value }]);
    expect(out.split("\n")).toEqual([
      "kind: Cluster",
      "apiVersion: kind.x-k8s.io/v1alpha4",
      "nodes:",
      "  - role: control-plane",
      `    image: "${DEFAULT_NODE_IMAGE}"`,
      "  - role: worker",
      `    image: "${DEFAULT_NODE_IMAGE}"`,
      "    labels:",
      `      ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
      "",
    ]);
    // nothing the scenario supplied starts a line of its own, so it cannot become a key of the node
    expect(out.split("\n").filter((l) => l.trimStart().startsWith(INJECTED))).toEqual([]);
  });
});

describe("kindNodeLimits", () => {
  it("defaults to 4 GiB without swap, 2 CPUs and 8192 pids per node", () => {
    expect(kindNodeLimits({})).toEqual({ Memory: 4096 * 1024 * 1024, MemorySwap: 4096 * 1024 * 1024, NanoCpus: 2e9, PidsLimit: 8192 });
  });

  it("reads the limits from the environment", () => {
    expect(kindNodeLimits({ KIND_NODE_MEMORY_MB: "6144", KIND_NODE_CPUS: "1.5", KIND_NODE_PIDS: "4096" })).toEqual({
      Memory: 6144 * 1024 * 1024,
      MemorySwap: 6144 * 1024 * 1024,
      NanoCpus: 1.5e9,
      PidsLimit: 4096,
    });
  });

  it("falls back to the defaults for values that would lift the limit", () => {
    expect(kindNodeLimits({ KIND_NODE_MEMORY_MB: "0", KIND_NODE_CPUS: "-1", KIND_NODE_PIDS: "many" })).toEqual(kindNodeLimits({}));
    expect(kindNodeLimits({ KIND_NODE_MEMORY_MB: "", KIND_NODE_CPUS: "Infinity" })).toEqual(kindNodeLimits({}));
  });
});

describe("KubernetesRuntimeProvider node limits", () => {
  it("limits every node container of the cluster and only reports what the daemon refuses or drops", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ Warnings: null })
      .mockRejectedValueOnce(new Error("no cgroup delegation"))
      .mockResolvedValueOnce({ Warnings: ["PIDs limit discarded."] });
    const listContainers = vi.fn().mockResolvedValue([{ Id: "cp" }, { Id: "w1" }, { Id: "w2" }]);
    const daemon = { listContainers, getContainer: (id: string) => ({ update: (limits: unknown) => update(id, limits) }) };
    const provider = new KubernetesRuntimeProvider({ socketPath: "/nonexistent/docker.sock", docker: daemon } as unknown as DockerRuntimeProvider);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await (provider as unknown as { limitNodes(cluster: string): Promise<void> }).limitNodes("wom-k8s-abc");

    expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: ["io.x-k8s.kind.cluster=wom-k8s-abc"] } });
    expect(update.mock.calls).toEqual(["cp", "w1", "w2"].map((id) => [id, kindNodeLimits()]));
    expect(stderr.mock.calls.map((c) => String(c[0]))).toEqual([
      "kind node limits not applied to wom-k8s-abc: no cgroup delegation",
      "kind node limits not applied to wom-k8s-abc: PIDs limit discarded.",
    ]);
    stderr.mockRestore();
  });

  it("does not fail when the node containers cannot even be listed", async () => {
    const daemon = { listContainers: vi.fn().mockRejectedValue(new Error("daemon is gone")) };
    const provider = new KubernetesRuntimeProvider({ socketPath: "/nonexistent/docker.sock", docker: daemon } as unknown as DockerRuntimeProvider);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect((provider as unknown as { limitNodes(cluster: string): Promise<void> }).limitNodes("wom-k8s-abc")).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });
});
