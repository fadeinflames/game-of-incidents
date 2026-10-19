import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KubernetesRuntimeProvider, pullDenial, type DockerRuntimeProvider } from "../src";

type Internals = {
  ensureImage(img: string): Promise<number>;
  destroy(h: unknown): Promise<void>;
  cachedArchive(img: string, dir: string): Promise<string>;
  saveArchive: (img: string, dest: string) => Promise<void>;
  kind: (args: string[]) => Promise<unknown>;
};
const internals = (p: KubernetesRuntimeProvider) => p as unknown as Internals;
const asDocker = (d: object) => ({ socketPath: "/nonexistent/docker.sock", ...d }) as unknown as DockerRuntimeProvider;

describe("pullDenial", () => {
  it.each(["postgres:16-alpine", "prom/prometheus:v2.55.1", "quay.io/jetstack/cert-manager-controller:v1.17.2", "registry.k8s.io/coredns/coredns:v1.14.6", "docker.io/library/nginx:1.27", "ghcr.io/letsencrypt/pebble:2.10.1"])(
    "lets the daemon pull %s",
    (img) => expect(pullDenial(img)).toBeNull(),
  );

  it.each(["wom-scenario/disk-full:dev", `wom-scenario/x@sha256:${"a".repeat(64)}`, "docker.io/wom-scenario/disk-full:dev", "wom-tools:dev", "wom-tools"])(
    "never pulls the platform image %s",
    (img) => expect(pullDenial(img)).toMatch(/never pulled/),
  );

  it.each(["evil.example/miner:1", "localhost:5000/x:1", "gcr.io/org/x:1", "attacker.io:443/wom-scenario/x"])("refuses a registry outside the list: %s", (img) => {
    expect(pullDenial(img)).toMatch(/allowed registries|never pulled/);
  });

  it("does not take a Docker Hub namespace that merely looks similar for a platform image", () => {
    expect(pullDenial("womscenario/x:1")).toBeNull();
    expect(pullDenial("someone/wom-scenario:1")).toBeNull();
  });
});

describe("KubernetesRuntimeProvider.ensureImage", () => {
  const notFound = () => Promise.reject(Object.assign(new Error("no such image"), { statusCode: 404 }));
  function provider(inspect: () => Promise<{ Size?: number }>) {
    const pull = vi.fn().mockResolvedValue({});
    const daemon = { getImage: () => ({ inspect }), pull, modem: { followProgress: (_s: unknown, done: (e: Error | null) => void) => done(null) } };
    return { pull, provider: new KubernetesRuntimeProvider(asDocker({ docker: daemon })) };
  }

  it("returns the size of an image that is present and pulls nothing", async () => {
    const { provider: p, pull } = provider(async () => ({ Size: 42 }));
    await expect(internals(p).ensureImage("wom-scenario/x:dev")).resolves.toBe(42);
    expect(pull).not.toHaveBeenCalled();
  });

  it("refuses to pull a missing platform image, whatever Docker Hub holds under that name", async () => {
    const { provider: p, pull } = provider(notFound);
    await expect(internals(p).ensureImage("wom-scenario/x:dev")).rejects.toThrow(/never pulled/);
    expect(pull).not.toHaveBeenCalled();
  });

  it("refuses a registry that is not on the list", async () => {
    const { provider: p, pull } = provider(notFound);
    await expect(internals(p).ensureImage("evil.example/miner:1")).rejects.toThrow(/allowed registries/);
    expect(pull).not.toHaveBeenCalled();
  });

  it("pulls an allowed public image and reports its size", async () => {
    let pulled = false;
    const { provider: p, pull } = provider(async () => {
      if (!pulled) throw Object.assign(new Error("no such image"), { statusCode: 404 });
      return { Size: 7 };
    });
    pull.mockImplementation(async () => {
      pulled = true;
      return {};
    });
    await expect(internals(p).ensureImage("postgres:16-alpine")).resolves.toBe(7);
    expect(pull).toHaveBeenCalledWith("postgres:16-alpine");
  });
});

describe("KubernetesRuntimeProvider.destroy", () => {
  it("removes by force the node containers that a failed kind delete left, then the network", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const removeNetwork = vi.fn().mockResolvedValue(undefined);
    const listContainers = vi.fn().mockResolvedValue([{ Id: "cp" }, { Id: "w1" }]);
    const p = new KubernetesRuntimeProvider(
      asDocker({
        docker: { listContainers, getContainer: (id: string) => ({ remove: (o: unknown) => remove(id, o) }) },
        listContainers: vi.fn().mockResolvedValue([]),
        removeNetwork,
      }),
    );
    internals(p).kind = vi.fn().mockRejectedValue(new Error("kind delete timed out"));

    await internals(p).destroy({ provider: "kubernetes", containerId: "", networkId: "net1", ownsNetwork: true, clusterName: "wom-k8s-abc" });

    expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: ["io.x-k8s.kind.cluster=wom-k8s-abc"] } });
    expect(remove.mock.calls).toEqual([
      ["cp", { force: true, v: true }],
      ["w1", { force: true, v: true }],
    ]);
    expect(removeNetwork).toHaveBeenCalledWith("net1");
  });
});

describe("KubernetesRuntimeProvider image archive cache", () => {
  const id = "a".repeat(64);
  const make = async (maxBytes: number) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wom-cache-test-"));
    const daemon = { getImage: () => ({ inspect: async () => ({ Id: `sha256:${id}` }) }) };
    const p = new KubernetesRuntimeProvider(asDocker({ docker: daemon }), { imageCacheDir: dir, imageCacheMaxBytes: maxBytes });
    const save = vi.fn(async (_img: string, dest: string) => fsp.writeFile(dest, "x".repeat(100)));
    internals(p).saveArchive = save;
    return { dir, p, save };
  };

  it("saves once per image id and reuses the archive afterwards", async () => {
    const { dir, p, save } = await make(1 << 20);
    const first = await internals(p).cachedArchive("nginx:1", dir);
    const second = await internals(p).cachedArchive("nginx:1", dir);
    expect(first).toBe(path.join(dir, `${id}.tar`));
    expect(second).toBe(first);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await fsp.readdir(dir)).toEqual([`${id}.tar`]);
    await fsp.rm(dir, { recursive: true });
  });

  it("evicts the least recently used archive past the grace period and keeps recent ones and the new one", async () => {
    const { dir, p } = await make(150);
    const old = path.join(dir, `${"b".repeat(64)}.tar`);
    const fresh = path.join(dir, `${"c".repeat(64)}.tar`);
    await fsp.writeFile(old, "x".repeat(100));
    await fsp.writeFile(fresh, "x".repeat(100));
    const longAgo = new Date(Date.now() - 3600_000);
    await fsp.utimes(old, longAgo, longAgo);

    const written = await internals(p).cachedArchive("nginx:1", dir);

    // 300 bytes against a 150 limit: the old one goes, the recently used one stays despite the pressure
    expect((await fsp.readdir(dir)).sort()).toEqual([path.basename(fresh), path.basename(written)].sort());
    await fsp.rm(dir, { recursive: true });
  });

  it("does not leave a partial file behind when saving fails", async () => {
    const { dir, p, save } = await make(1 << 20);
    save.mockImplementationOnce(async (_img: string, dest: string) => {
      await fsp.writeFile(dest, "half");
      throw new Error("docker save failed");
    });
    await expect(internals(p).cachedArchive("nginx:1", dir)).rejects.toThrow(/docker save failed/);
    expect(await fsp.readdir(dir)).toEqual([]);
    await fsp.rm(dir, { recursive: true });
  });
});
