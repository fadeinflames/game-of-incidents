// The runtime providers against stand-ins for the daemon and for kind: what create/runScript/destroy/list/status ask of
// them and what limits a container is created with. No Docker, no kind binary.
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NODE_IMAGE,
  DockerRuntimeProvider,
  KubernetesRuntimeProvider,
  OWNER_LABEL,
  PROVIDER_LABEL,
  ProvisioningAborted,
  ROLE_LABEL,
  SANDBOX_LABEL,
  SESSION_LABEL,
  type ExecResult,
  type SandboxHandle,
  type SandboxSpec,
} from "../src";

afterEach(() => vi.restoreAllMocks());

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: "wom-scenario/x:1",
  hostname: "web-01",
  writable: ["/etc", "/var"],
  tmpfs: { "/tmp": "size=64m" },
  capAdd: ["CHOWN"],
  sudo: false,
  resources: { cpus: 1.5, memoryMb: 256, pids: 100 },
  labels: { [SESSION_LABEL]: "abc123" },
  ...over,
});

const notFound = () => Object.assign(new Error("no such container"), { statusCode: 404 });

describe("DockerRuntimeProvider.create: limits and isolation", () => {
  function stubbed() {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    const createNetwork = vi.spyOn(provider.docker, "createNetwork").mockResolvedValue({ id: "net-1" } as Docker.Network);
    const createContainer = vi.spyOn(provider.docker, "createContainer").mockResolvedValue({ id: "ctr-1", start: async () => undefined } as unknown as Docker.Container);
    const removeNetwork = vi.spyOn(provider, "removeNetwork").mockResolvedValue(undefined);
    return { provider, createNetwork, createContainer, removeNetwork };
  }

  it("applies the scenario's limits to the container: memory without swap, cpus, pids, read-only root, tmpfs", async () => {
    const { provider, createContainer } = stubbed();
    await provider.create(spec());
    const opts = createContainer.mock.calls[0]![0];
    const host = opts.HostConfig!;
    expect(host.Memory).toBe(256 * 1024 * 1024);
    expect(host.MemorySwap).toBe(256 * 1024 * 1024); // equal to Memory: no swap
    expect(host.NanoCpus).toBe(1.5e9);
    expect(host.PidsLimit).toBe(100);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Tmpfs).toEqual({ "/tmp": "size=64m" });
    expect(host.NetworkMode).toBe("net-1");
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.Privileged).toBe(false);
    expect(opts.Volumes).toEqual({ "/etc": {}, "/var": {} });
    expect(opts.Image).toBe("wom-scenario/x:1");
    expect(opts.Hostname).toBe("web-01");
  });

  it("no-new-privileges unless the scenario needs setuid sudo", async () => {
    const off = stubbed();
    await off.provider.create(spec({ sudo: false }));
    expect(off.createContainer.mock.calls[0]![0].HostConfig!.SecurityOpt).toEqual(["no-new-privileges"]);
    const on = stubbed();
    await on.provider.create(spec({ sudo: true }));
    expect(on.createContainer.mock.calls[0]![0].HostConfig!.SecurityOpt).toEqual([]);
  });

  it("its own network is internal (no egress), labelled, and the handle says it owns it", async () => {
    const { provider, createNetwork } = stubbed();
    const handle = await provider.create(spec());
    expect(createNetwork).toHaveBeenCalledWith(expect.objectContaining({ Name: "wom-sb-abc123", Internal: true, Labels: expect.objectContaining({ [SANDBOX_LABEL]: "sandbox", [SESSION_LABEL]: "abc123" }) }));
    expect(handle).toEqual({ provider: "docker", containerId: "ctr-1", networkId: "net-1", ownsNetwork: true });
  });

  it("a network handed in is used as it is, never created and never owned", async () => {
    const { provider, createNetwork, createContainer } = stubbed();
    const handle = await provider.create(spec({ networkId: "shared" }));
    expect(createNetwork).not.toHaveBeenCalled();
    expect(createContainer.mock.calls[0]![0].HostConfig!.NetworkMode).toBe("shared");
    expect(handle.ownsNetwork).toBe(false);
  });

  it("a container that cannot be created removes the network it made, and only that one", async () => {
    const own = stubbed();
    own.createContainer.mockRejectedValue(new Error("image not found"));
    await expect(own.provider.create(spec())).rejects.toThrow("image not found");
    expect(own.removeNetwork).toHaveBeenCalledWith("net-1");

    const shared = stubbed();
    shared.createContainer.mockRejectedValue(new Error("image not found"));
    await expect(shared.provider.create(spec({ networkId: "shared" }))).rejects.toThrow("image not found");
    expect(shared.removeNetwork).not.toHaveBeenCalled();
  });

  it("a session killed before the daemon is asked creates nothing", async () => {
    const { provider, createNetwork, createContainer } = stubbed();
    const abort = new AbortController();
    abort.abort();
    await expect(provider.create(spec({ signal: abort.signal }))).rejects.toBeInstanceOf(ProvisioningAborted);
    expect(createNetwork).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
  });

  it("reports the provisioning phase", async () => {
    const { provider } = stubbed();
    const onProgress = vi.fn();
    await provider.create(spec({ onProgress }));
    expect(onProgress).toHaveBeenCalledWith("sandbox");
  });
});

describe("DockerRuntimeProvider.destroy", () => {
  function destroying(remove: () => Promise<unknown>) {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    const removeContainer = vi.fn(remove);
    vi.spyOn(provider.docker, "getContainer").mockReturnValue({ remove: removeContainer } as unknown as Docker.Container);
    const removeNetwork = vi.spyOn(provider, "removeNetwork").mockResolvedValue(undefined);
    return { provider, removeContainer, removeNetwork };
  }
  const handle: SandboxHandle = { provider: "docker", containerId: "ctr", networkId: "net", ownsNetwork: true };

  it("removes the container by force with its anonymous volumes, then its network", async () => {
    const { provider, removeContainer, removeNetwork } = destroying(async () => undefined);
    await provider.destroy(handle);
    expect(removeContainer).toHaveBeenCalledWith({ force: true, v: true });
    expect(removeNetwork).toHaveBeenCalledWith("net");
  });

  it("leaves a network it does not own", async () => {
    const { provider, removeNetwork } = destroying(async () => undefined);
    await provider.destroy({ ...handle, ownsNetwork: false });
    expect(removeNetwork).not.toHaveBeenCalled();
  });

  it("a container that is already gone (404) is not an error: destroy can be repeated", async () => {
    const { provider, removeNetwork } = destroying(async () => Promise.reject(notFound()));
    await expect(provider.destroy(handle)).resolves.toBeUndefined();
    expect(removeNetwork).toHaveBeenCalledWith("net");
  });

  it("any other daemon error reaches the caller, so the reconciler retries and the failure is counted", async () => {
    const { provider, removeNetwork } = destroying(async () => Promise.reject(Object.assign(new Error("daemon is busy"), { statusCode: 500 })));
    await expect(provider.destroy(handle)).rejects.toThrow("daemon is busy");
    expect(removeNetwork).not.toHaveBeenCalled();
  });
});

describe("DockerRuntimeProvider.status and list", () => {
  const h: SandboxHandle = { provider: "docker", containerId: "ctr", networkId: "net" };

  it("status: running, exited, missing, and an unknown error is not read as 'missing'", async () => {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    const inspect = vi.fn();
    vi.spyOn(provider.docker, "getContainer").mockReturnValue({ inspect } as unknown as Docker.Container);
    inspect.mockResolvedValueOnce({ State: { Running: true } });
    expect(await provider.status(h)).toBe("running");
    inspect.mockResolvedValueOnce({ State: { Running: false } });
    expect(await provider.status(h)).toBe("exited");
    inspect.mockRejectedValueOnce(notFound());
    expect(await provider.status(h)).toBe("missing");
    inspect.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(provider.status(h)).rejects.toThrow("socket hang up");
  });

  it("list: sandboxes of the platform only, without the containers of kubernetes sessions", async () => {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    const listContainers = vi.spyOn(provider.docker, "listContainers").mockResolvedValue([
      { Id: "plain", Created: 1_700_000_000, Labels: { [SESSION_LABEL]: "s1", [OWNER_LABEL]: "orchestrator" }, NetworkSettings: { Networks: { n: { NetworkID: "net-plain" } } } },
      { Id: "tools", Created: 1_700_000_100, Labels: { [SESSION_LABEL]: "s2", [PROVIDER_LABEL]: "kubernetes", [ROLE_LABEL]: "tools" }, NetworkSettings: { Networks: {} } },
      { Id: "nolabels", Created: 1_700_000_200, NetworkSettings: undefined },
    ] as unknown as Docker.ContainerInfo[]);
    const out = await provider.list();
    expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: [`${SANDBOX_LABEL}=sandbox`] } });
    expect(out.map((s) => s.handle.containerId)).toEqual(["plain", "nolabels"]);
    expect(out[0]).toMatchObject({ sessionId: "s1", handle: { provider: "docker", networkId: "net-plain" }, createdAt: new Date(1_700_000_000_000) });
    expect(out[1]).toMatchObject({ sessionId: null, handle: { networkId: "" }, labels: {} });
  });
});

// ---------- kubernetes ----------

/** the docker provider the kubernetes one stands on, as recorded stand-ins */
function fakeDocker() {
  const calls: string[] = [];
  const runner: { scripts: { handle: SandboxHandle; script: string }[]; result: ExecResult } = { scripts: [], result: { exitCode: 0, stdout: "", stderr: "", timedOut: false } };
  const created: SandboxSpec[] = [];
  const docker = {
    socketPath: "/nonexistent/docker.sock",
    createInternalNetwork: vi.fn(async (name: string) => (calls.push(`network:${name}`), { id: `net-${name}`, name })),
    create: vi.fn(async (s: SandboxSpec): Promise<SandboxHandle> => {
      created.push(s);
      const role = s.labels[ROLE_LABEL] ?? "plain";
      calls.push(`create:${role}`);
      return { provider: "docker", containerId: `ctr-${role}-${created.length}`, networkId: s.networkId ?? "", ownsNetwork: false };
    }),
    runScript: vi.fn(async (handle: SandboxHandle, script: string) => {
      runner.scripts.push({ handle, script });
      return runner.result;
    }),
    destroy: vi.fn(async (h: SandboxHandle) => void calls.push(`destroy:${h.containerId}`)),
    removeNetwork: vi.fn(async (id: string) => void calls.push(`removeNetwork:${id}`)),
    listContainers: vi.fn(async (): Promise<unknown[]> => []),
    status: vi.fn(async () => "running" as const),
    docker: { listContainers: vi.fn(async (): Promise<unknown[]> => []), getContainer: vi.fn(() => ({ update: vi.fn(async () => ({})), remove: vi.fn(async () => undefined) })) },
  };
  return { docker, calls, runner, created };
}

function kubernetes() {
  const fake = fakeDocker();
  const provider = new KubernetesRuntimeProvider(fake.docker as unknown as DockerRuntimeProvider, { kindBin: "kind", toolsImage: "wom-tools:test", clusterWaitSec: 60 });
  const kindCalls: { args: string[]; env: Record<string, string> }[] = [];
  let clusters = "";
  vi.spyOn(provider as unknown as { kind(...a: unknown[]): Promise<{ stdout: string }> }, "kind").mockImplementation(async (args: unknown, env: unknown) => {
    const a = args as string[];
    kindCalls.push({ args: a, env: (env as Record<string, string>) ?? {} });
    fake.calls.push(`kind:${a.slice(0, 2).join(" ")}`);
    if (a[0] === "get" && a[1] === "kubeconfig") return { stdout: "apiVersion: v1\nkind: Config\n" };
    if (a[0] === "get" && a[1] === "clusters") return { stdout: clusters };
    return { stdout: "" };
  });
  return { provider, fake, kindCalls, setClusters: (names: string[]) => void (clusters = names.join("\n") + "\n") };
}

const k8sSpec = (over: Partial<SandboxSpec> = {}) =>
  spec({
    image: "wom-tools:dev",
    sudo: true,
    labels: { [SESSION_LABEL]: "abc123", [OWNER_LABEL]: "orchestrator" },
    kubernetes: { nodes: 2, nodeImage: DEFAULT_NODE_IMAGE, workerLabels: [{ zone: "a" }], manifests: [{ name: "app.yaml", content: "kind: Deployment\n" }], images: [] },
    ...over,
  });

describe("KubernetesRuntimeProvider.create", () => {
  it("builds the cluster on its own bridge, then the tools container on that network, then applies the manifests through a runner", async () => {
    const { provider, fake, kindCalls } = kubernetes();
    const phases: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {}); // "no node containers found": the stand-in daemon lists none
    const handle = await provider.create(k8sSpec({ onProgress: (p) => void phases.push(p) }));

    expect(fake.docker.createInternalNetwork).toHaveBeenCalledWith("wom-k8s-abc123", expect.objectContaining({ [PROVIDER_LABEL]: "kubernetes" }), { internal: false, bridgeName: "wk8sabc123" });
    const create = kindCalls.find((c) => c.args[0] === "create")!;
    expect(create.args.slice(0, 4)).toEqual(["create", "cluster", "--name", "wom-k8s-abc123"]);
    expect(create.args).toContain("--wait");
    expect(create.env).toEqual({ KIND_EXPERIMENTAL_DOCKER_NETWORK: "wom-k8s-abc123" });

    const tools = fake.created[0]!;
    expect(tools).toMatchObject({ image: "wom-tools:dev", networkId: "net-wom-k8s-abc123", kubernetes: undefined, sudo: true });
    expect(tools.labels).toMatchObject({ [ROLE_LABEL]: "tools", [PROVIDER_LABEL]: "kubernetes", [SESSION_LABEL]: "abc123" });
    expect(fake.runner.scripts[0]!.script).toContain("apiVersion: v1"); // the kubeconfig lands in the tools container
    expect(fake.runner.scripts[0]!.handle.containerId).toBe("ctr-tools-1");

    expect(handle).toMatchObject({ provider: "kubernetes", containerId: "ctr-tools-1", networkId: "net-wom-k8s-abc123", ownsNetwork: true, clusterName: "wom-k8s-abc123" });
    expect(handle.kubeconfig).toContain("kind: Config");
    // the manifests are applied by an ephemeral runner, which is gone afterwards
    const apply = fake.runner.scripts.find((s) => s.script.includes("kubectl apply"))!;
    expect(apply.script).toContain("kind: Deployment");
    expect(fake.created[1]!.labels[ROLE_LABEL]).toBe("runner");
    expect(fake.docker.destroy).toHaveBeenCalledWith(expect.objectContaining({ containerId: "ctr-runner-2", ownsNetwork: false }));
    expect(phases).toEqual(["cluster", "tools", "manifests"]);
  });

  it("without manifests there is no runner", async () => {
    const { provider, fake } = kubernetes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await provider.create(k8sSpec({ kubernetes: { nodes: 1, nodeImage: DEFAULT_NODE_IMAGE, manifests: [], images: [] } }));
    expect(fake.created.map((s) => s.labels[ROLE_LABEL])).toEqual(["tools"]);
  });

  it("a node image that is not a kindest release fails before anything is created", async () => {
    const { provider, fake } = kubernetes();
    await expect(provider.create(k8sSpec({ kubernetes: { nodes: 1, nodeImage: "evil/node:v1.0.0", manifests: [], images: [] } }))).rejects.toThrow(/nodeImage/);
    expect(fake.docker.createInternalNetwork).not.toHaveBeenCalled();
  });

  it("a spec without a cluster is refused", async () => {
    await expect(kubernetes().provider.create(spec())).rejects.toThrow(/spec.kubernetes/);
  });

  it("a failing step tears the half-built stand down (cluster, containers, network) and reports the failure", async () => {
    const { provider, fake, kindCalls } = kubernetes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.runner.result = { exitCode: 1, stdout: "", stderr: "mkdir: permission denied", timedOut: false };
    await expect(provider.create(k8sSpec())).rejects.toThrow(/seeding kubeconfig/);
    expect(kindCalls.some((c) => c.args[0] === "delete" && c.args.includes("wom-k8s-abc123"))).toBe(true);
    expect(fake.docker.removeNetwork).toHaveBeenCalledWith("net-wom-k8s-abc123");
  });

  it("a session killed while the cluster is being built stops at the next step and cleans up", async () => {
    const { provider, fake } = kubernetes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const abort = new AbortController();
    fake.docker.createInternalNetwork.mockImplementation(async (name: string) => {
      abort.abort(); // the kill arrives while the network is being created
      return { id: `net-${name}`, name };
    });
    await expect(provider.create(k8sSpec({ signal: abort.signal }))).rejects.toBeInstanceOf(ProvisioningAborted);
    expect(fake.created).toEqual([]);
    expect(fake.docker.removeNetwork).toHaveBeenCalledWith("net-wom-k8s-abc123");
  });

  it("failed manifests are reported with the end of the kubectl output", async () => {
    const { provider, fake } = kubernetes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.docker.runScript.mockImplementation(async (_h: SandboxHandle, script: string) => (script.includes("kubectl apply") ? { exitCode: 1, stdout: "", stderr: "error: unable to recognize app.yaml", timedOut: false } : fake.runner.result));
    await expect(provider.create(k8sSpec())).rejects.toThrow(/applying manifests failed: error: unable to recognize/);
  });
});

describe("KubernetesRuntimeProvider.runScript", () => {
  const handle: SandboxHandle = { provider: "kubernetes", containerId: "ctr-tools", networkId: "net-k", ownsNetwork: true, clusterName: "wom-k8s-abc123", kubeconfig: "apiVersion: v1\n" };

  it("runs the script in an ephemeral runner on the cluster network: no sudo, no capabilities, small limits, kubeconfig first", async () => {
    const { provider, fake } = kubernetes();
    fake.runner.result = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    const r = await provider.runScript(handle, "#!/bin/sh\nkubectl get nodes\n", { user: "root", timeoutMs: 5_000 });
    expect(r.stdout).toBe("ok");
    const runner = fake.created[0]!;
    expect(runner).toMatchObject({ image: "wom-tools:test", networkId: "net-k", sudo: false, capAdd: [], writable: [], resources: { cpus: 1, memoryMb: 256, pids: 128 } });
    expect(runner.labels).toMatchObject({ [ROLE_LABEL]: "runner", [PROVIDER_LABEL]: "kubernetes", [SESSION_LABEL]: "abc123", [OWNER_LABEL]: "orchestrator" });
    const sent = fake.runner.scripts[0]!.script;
    expect(sent.startsWith("mkdir -p /tmp/wom")).toBe(true);
    expect(sent).toContain("export KUBECONFIG=/tmp/wom/kubeconfig");
    expect(sent).toContain("kubectl get nodes");
    expect(sent).not.toContain("#!/bin/sh"); // the shebang of the scenario script is dropped, the runner's own shell reads it
    expect(fake.docker.runScript).toHaveBeenCalledWith(expect.anything(), expect.any(String), { user: "root", timeoutMs: 5_000, signal: undefined });
  });

  it("the runner is removed (not its network) even when the script cannot be run", async () => {
    const { provider, fake } = kubernetes();
    fake.docker.runScript.mockRejectedValue(new Error("daemon went away"));
    await expect(provider.runScript(handle, "true", { user: "root", timeoutMs: 1000 })).rejects.toThrow("daemon went away");
    expect(fake.docker.destroy).toHaveBeenCalledWith(expect.objectContaining({ containerId: "ctr-runner-1", ownsNetwork: false }));
  });

  it("a handle without a kubeconfig is refused before a container is made", async () => {
    const { provider, fake } = kubernetes();
    await expect(provider.runScript({ ...handle, kubeconfig: undefined }, "true", { user: "root", timeoutMs: 1000 })).rejects.toThrow(/kubeconfig/);
    expect(fake.docker.create).not.toHaveBeenCalled();
  });
});

describe("KubernetesRuntimeProvider.status", () => {
  const handle: SandboxHandle = { provider: "kubernetes", containerId: "ctr-tools", networkId: "net-k", clusterName: "wom-k8s-abc123" };

  it("a cluster kind no longer lists is missing, whatever the tools container says", async () => {
    const { provider, fake, setClusters } = kubernetes();
    setClusters(["wom-k8s-other"]);
    expect(await provider.status(handle)).toBe("missing");
    expect(fake.docker.status).not.toHaveBeenCalled();
  });

  it("a live cluster takes the state of the tools container", async () => {
    const { provider, fake, setClusters } = kubernetes();
    setClusters(["wom-k8s-abc123"]);
    fake.docker.status.mockResolvedValue("exited" as never);
    expect(await provider.status(handle)).toBe("exited");
  });

  it("a cluster whose tools container is not made yet is running", async () => {
    const { provider, setClusters } = kubernetes();
    setClusters(["wom-k8s-abc123"]);
    expect(await provider.status({ ...handle, containerId: "" })).toBe("running");
  });
});

describe("KubernetesRuntimeProvider.list", () => {
  it("lists the tools containers and the clusters that have none, telling the command-line ones apart", async () => {
    const { provider, fake, setClusters } = kubernetes();
    const tools = { handle: { provider: "docker", containerId: "ctr-tools", networkId: "net-k" }, sessionId: "abc", createdAt: new Date(5000), labels: { [ROLE_LABEL]: "tools", [PROVIDER_LABEL]: "kubernetes" } };
    const runner = { handle: { provider: "docker", containerId: "ctr-runner", networkId: "net-k" }, sessionId: "abc", createdAt: new Date(6000), labels: { [ROLE_LABEL]: "runner", [PROVIDER_LABEL]: "kubernetes" } };
    fake.docker.listContainers.mockResolvedValue([tools, runner]);
    fake.docker.docker.listContainers.mockResolvedValue([
      { Id: "n1", Created: 1000, Labels: { "io.x-k8s.kind.cluster": "wom-k8s-crashed" } },
      { Id: "n2", Created: 900, Labels: { "io.x-k8s.kind.cluster": "wom-k8s-crashed" } },
    ]);
    setClusters(["wom-k8s-abc", "wom-k8s-crashed", "wom-k8s-test-demo", "kind", "wom-k8s-run-demo"]);

    const out = await provider.list();

    expect(fake.docker.listContainers).toHaveBeenCalledWith([`${PROVIDER_LABEL}=kubernetes`]);
    expect(out.map((s) => s.sessionId)).toEqual(["abc", "crashed", "test-demo", "run-demo"]); // the runner and a foreign cluster are not listed
    expect(out[0]!.handle).toMatchObject({ provider: "kubernetes", containerId: "ctr-tools", clusterName: "wom-k8s-abc", ownsNetwork: true });
    expect(out[1]).toMatchObject({ handle: { containerId: "", clusterName: "wom-k8s-crashed", networkId: "wom-k8s-crashed" }, createdAt: new Date(900_000), labels: { [OWNER_LABEL]: "orchestrator" } });
    expect(out[2]!.labels[OWNER_LABEL]).toBe("cli");
    expect(out[3]!.labels[OWNER_LABEL]).toBe("cli");
  });
});

describe("KubernetesRuntimeProvider.destroy", () => {
  it("deletes the cluster, removes what kind left, the session's containers and the network", async () => {
    const { provider, fake, kindCalls } = kubernetes();
    fake.docker.listContainers.mockResolvedValue([{ handle: { provider: "docker", containerId: "ctr-tools", networkId: "net-k" } }, { handle: { provider: "docker", containerId: "ctr-runner", networkId: "net-k" } }]);
    await provider.destroy({ provider: "kubernetes", containerId: "ctr-tools", networkId: "net-k", ownsNetwork: true, clusterName: "wom-k8s-abc123" });
    expect(kindCalls.some((c) => c.args.join(" ") === "delete cluster --name wom-k8s-abc123")).toBe(true);
    expect(fake.docker.listContainers).toHaveBeenCalledWith([`${SESSION_LABEL}=abc123`, `${PROVIDER_LABEL}=kubernetes`]);
    expect(fake.docker.destroy.mock.calls.map((c) => (c[0] as SandboxHandle).containerId)).toEqual(["ctr-tools", "ctr-runner"]);
    expect(fake.docker.removeNetwork).toHaveBeenCalledWith("net-k");
  });

  it("a network that cannot be removed is reported to the caller, not swallowed", async () => {
    const { provider, fake } = kubernetes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.docker.removeNetwork.mockRejectedValue(new Error("network has active endpoints"));
    await expect(provider.destroy({ provider: "kubernetes", containerId: "", networkId: "net-k", ownsNetwork: true, clusterName: "wom-k8s-abc123" })).rejects.toThrow("active endpoints");
  });

  it("a network somebody else owns is left alone", async () => {
    const { provider, fake } = kubernetes();
    await provider.destroy({ provider: "kubernetes", containerId: "", networkId: "net-k", ownsNetwork: false, clusterName: "wom-k8s-abc123" });
    expect(fake.docker.removeNetwork).not.toHaveBeenCalled();
  });
});
