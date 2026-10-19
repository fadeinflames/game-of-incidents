import { describe, expect, it, vi } from "vitest";
import { FakeRuntimeProvider, KubernetesRuntimeProvider, RuntimeRegistry, type DockerRuntimeProvider, type SandboxHandle, type SandboxSpec } from "../src";

const k8sHandle: SandboxHandle = { provider: "kubernetes", containerId: "", networkId: "net", ownsNetwork: true, clusterName: "wom-k8s-a" };
const k8sSpec = { image: "x", writable: [], tmpfs: {}, capAdd: [], sudo: false, resources: { cpus: 1, memoryMb: 1, pids: 1 }, labels: {}, kubernetes: { nodes: 1, nodeImage: "kindest/node:v1.31.0", manifests: [], images: [] } } as SandboxSpec;

/** a kubernetes side whose kind binary is controlled by the test */
function kubernetesSide(ping: () => Promise<void>) {
  const fake = new FakeRuntimeProvider();
  fake.addOrphan("k8s-session");
  return Object.assign(fake, { ping: vi.fn(ping) });
}

describe("RuntimeRegistry kubernetes availability", () => {
  it("starts ready when a provider is configured and disabled when there is none", () => {
    expect(new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes: kubernetesSide(async () => {}) }).kubernetesState()).toBe("ready");
    expect(new RuntimeRegistry({ docker: new FakeRuntimeProvider() }).kubernetesState()).toBe("disabled");
  });

  it("retries the ping at startup instead of giving kubernetes up after one failure", async () => {
    let calls = 0;
    const k = kubernetesSide(async () => {
      if (++calls < 3) throw new Error("kind: not ready yet");
    });
    const reg = new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes: k });
    await expect(reg.probeKubernetes({ attempts: 5, delayMs: 1 })).resolves.toBe("ready");
    expect(k.ping).toHaveBeenCalledTimes(3);
    expect(reg.kubernetesState()).toBe("ready");
  });

  it("is unavailable once every attempt failed, and recovers by itself on a later probe", async () => {
    let up = false;
    const k = kubernetesSide(async () => {
      if (!up) throw new Error("kind: executable file not found");
    });
    const reg = new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes: k });
    await expect(reg.probeKubernetes({ attempts: 2, delayMs: 1 })).resolves.toBe("unavailable");
    expect(k.ping).toHaveBeenCalledTimes(2);
    expect(reg.kubernetesState()).toBe("unavailable");
    up = true;
    await expect(reg.probeKubernetes()).resolves.toBe("ready");
    expect(reg.kubernetesState()).toBe("ready");
  });

  it("concurrent probes share one", async () => {
    const k = kubernetesSide(async () => {});
    const reg = new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes: k });
    await Promise.all([reg.probeKubernetes(), reg.probeKubernetes(), reg.probeKubernetes()]);
    expect(k.ping).toHaveBeenCalledTimes(1);
  });

  it("does not list kubernetes sandboxes while kind is unavailable, so their absence cannot be read as 'gone'", async () => {
    const k = kubernetesSide(async () => Promise.reject(new Error("down")));
    const reg = new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes: k });
    expect(await reg.list()).toHaveLength(1);
    await reg.probeKubernetes();
    expect(await reg.list()).toHaveLength(0);
  });

  it("a create for kubernetes probes once before refusing, and goes through when kind is back", async () => {
    let up = false;
    const k = kubernetesSide(async () => {
      if (!up) throw new Error("down");
    });
    const reg = new RuntimeRegistry({ docker: new FakeRuntimeProvider(), kubernetes: k });
    await reg.probeKubernetes();
    await expect(reg.create(k8sSpec)).rejects.toThrow(/kubernetes runtime is unavailable/);
    up = true;
    await expect(reg.create(k8sSpec)).resolves.toMatchObject({ provider: "docker" }); // the fake side answers
  });

  it("an operation on a kubernetes handle without a provider is a rejected promise, not a synchronous throw", async () => {
    const reg = new RuntimeRegistry({ docker: new FakeRuntimeProvider() });
    // the reconciler writes status(h).catch(...): a synchronous throw would skip the catch and fail the whole pass
    const p = reg.status(k8sHandle);
    await expect(p).rejects.toThrow(/not configured/);
    await expect(reg.create(k8sSpec)).rejects.toThrow(/not configured/);
    await expect(reg.destroy(k8sHandle)).rejects.toThrow(/not configured/);
    await expect(reg.runScript(k8sHandle, "true", { user: "root", timeoutMs: 1 })).rejects.toThrow(/not configured/);
  });

  it("removeOrphanNetworks goes to the docker side with the age limit, and is 0 for a side without it", async () => {
    const docker = Object.assign(new FakeRuntimeProvider(), { removeOrphanNetworks: vi.fn(async () => 2) });
    expect(await new RuntimeRegistry({ docker }).removeOrphanNetworks(600_000)).toBe(2);
    expect(docker.removeOrphanNetworks).toHaveBeenCalledWith(600_000);
    expect(await new RuntimeRegistry({ docker: new FakeRuntimeProvider() }).removeOrphanNetworks(1)).toBe(0);
  });
});

describe("KubernetesRuntimeProvider cluster list", () => {
  type Internals = { kind: (args: string[]) => Promise<{ stdout: string }> };
  const provider = () => {
    const p = new KubernetesRuntimeProvider({ socketPath: "/nonexistent/docker.sock" } as unknown as DockerRuntimeProvider);
    const kind = vi.fn(async (_args: string[]) => ({ stdout: "wom-k8s-a\nwom-k8s-b\n" }));
    (p as unknown as Internals).kind = kind;
    return { p, kind };
  };

  it("asks kind once for a whole reconcile pass, not once per session", async () => {
    const { p, kind } = provider();
    const states = await Promise.all(Array.from({ length: 6 }, () => p.status(k8sHandle)));
    expect(states).toEqual(Array(6).fill("running"));
    await p.status(k8sHandle);
    expect(kind).toHaveBeenCalledTimes(1);
    expect(kind).toHaveBeenCalledWith(["get", "clusters"]);
  });

  it("asks again after the short validity ran out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { p, kind } = provider();
      await p.status(k8sHandle);
      vi.setSystemTime(Date.now() + 6_000);
      await p.status(k8sHandle);
      expect(kind).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a destroy drops the cached list, so a removed cluster is not reported as present", async () => {
    const listContainers = vi.fn().mockResolvedValue([]);
    const docker = { socketPath: "/nonexistent/docker.sock", docker: { listContainers }, listContainers, removeNetwork: vi.fn() } as unknown as DockerRuntimeProvider;
    const p = new KubernetesRuntimeProvider(docker);
    let out = "wom-k8s-a\n";
    const kind = vi.fn(async (args: string[]) => ({ stdout: args[0] === "get" ? out : "" }));
    (p as unknown as Internals).kind = kind;
    expect(await p.status(k8sHandle)).toBe("running");
    out = "";
    await p.destroy({ ...k8sHandle, ownsNetwork: false });
    expect(await p.status(k8sHandle)).toBe("missing");
  });

  it("does not keep a failed lookup: the next call asks kind again", async () => {
    const { p, kind } = provider();
    kind.mockRejectedValueOnce(new Error("docker: cannot connect"));
    expect(await p.status(k8sHandle)).toBe("missing");
    expect(await p.status(k8sHandle)).toBe("running");
    expect(kind).toHaveBeenCalledTimes(2);
  });

  it("a destroy that cannot remove the network fails, instead of reporting a clean sandbox", async () => {
    const listContainers = vi.fn().mockResolvedValue([]);
    const removeNetwork = vi.fn().mockRejectedValue(new Error("network has active endpoints"));
    const docker = { socketPath: "/nonexistent/docker.sock", docker: { listContainers }, listContainers, removeNetwork } as unknown as DockerRuntimeProvider;
    const p = new KubernetesRuntimeProvider(docker);
    (p as unknown as Internals).kind = vi.fn(async () => ({ stdout: "" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(p.destroy(k8sHandle)).rejects.toThrow(/active endpoints/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("was not removed"));
    log.mockRestore();
  });
});
