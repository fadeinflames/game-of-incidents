// KubernetesRuntimeProvider (ADR-0008): one kind cluster per session on its own egress-less docker network,
// a hardened "tools" container (kubectl, kubeconfig) as the user's terminal, and ephemeral "runner" containers
// (same tools image, no sudo) that execute break/check/solve with the admin kubeconfig. The kind node is never the shell.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DockerRuntimeProvider } from "./docker";
import { NODE_IMAGE_RE } from "./spec";
import {
  DEFAULT_TMPFS,
  KIND_CLUSTER_PREFIX,
  OWNER_LABEL,
  PROVIDER_LABEL,
  ProvisioningAborted,
  ROLE_LABEL,
  SESSION_LABEL,
  type ExecResult,
  type ListedSandbox,
  type RuntimeProvider,
  type SandboxHandle,
  type SandboxSpec,
  type SandboxStatus,
  type ScriptOptions,
  type TerminalOptions,
  type TerminalStream,
} from "./types";

const execFileP = promisify(execFile);

export type KubernetesProviderOptions = {
  /** path to the kind binary (needs the docker CLI on PATH and DOCKER_HOST pointing at the sandbox daemon) */
  kindBin?: string;
  dockerHost?: string;
  /** image for tools + runner containers */
  toolsImage?: string;
  clusterWaitSec?: number;
  /** directory for docker-save archives keyed by image id (default: env WOM_IMAGE_CACHE_DIR; unset => no cache) */
  imageCacheDir?: string;
  /** size at which the least recently used archives are evicted (default: env WOM_IMAGE_CACHE_MAX_MB, 10240) */
  imageCacheMaxBytes?: number;
};

/** registries the sandbox daemon may pull from (docker.io is the implicit one); covers every public image the repository scenarios use
 *  (ghcr.io: letsencrypt/pebble of cert-expired) */
export const PULL_REGISTRIES = ["docker.io", "quay.io", "registry.k8s.io", "ghcr.io"];
/** images the platform builds itself: a missing one is an error, never a pull of a same-named image from a public registry */
const PLATFORM_IMAGE_RE = /^(wom-scenario|wom-tools)(\/|:|@|$)/;
/** uncompressed size of the public images one cluster may need */
export const PUBLIC_IMAGES_MAX_BYTES = 3 * 1024 ** 3;
const ARCHIVE_MAX_AGE_MS = 30 * 60 * 1000;
/** how long the list of kind clusters is trusted before `kind get clusters` runs again */
const CLUSTER_NAMES_TTL_MS = 5_000;
/** an archive used or written this recently is never evicted: a cluster may still be loading it */
const ARCHIVE_GRACE_MS = 15 * 60 * 1000;

function splitRegistry(img: string): { registry: string; rest: string } {
  const first = img.split("/")[0]!;
  const explicit = img.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return explicit ? { registry: first, rest: img.slice(first.length + 1) } : { registry: "docker.io", rest: img };
}

export function isPlatformImage(img: string): boolean {
  return PLATFORM_IMAGE_RE.test(splitRegistry(img).rest);
}

/** why `img` may not be pulled, or null */
export function pullDenial(img: string): string | null {
  if (isPlatformImage(img)) return `image ${img} is built by the platform and is not present on this host; it is never pulled`;
  const { registry } = splitRegistry(img);
  if (!PULL_REGISTRIES.includes(registry)) return `image ${img} would be pulled from ${registry}; allowed registries: ${PULL_REGISTRIES.join(", ")}`;
  return null;
}

const RUNNER_CAPS: string[] = [];

/** `docker update` payload for every node container of a session cluster. kind has no resource options for its
 *  nodes, and the player is cluster-admin: without these one session can take the whole host. */
export function kindNodeLimits(env: NodeJS.ProcessEnv = process.env) {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const memory = Math.round(num("KIND_NODE_MEMORY_MB", 4096)) * 1024 * 1024;
  return {
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: Math.round(num("KIND_NODE_CPUS", 2) * 1e9),
    PidsLimit: Math.round(num("KIND_NODE_PIDS", 8192)),
  };
}

export function kindConfig(nodes: number, nodeImage: string, workerLabels: Record<string, string>[] = []): string {
  // the value comes from an uploaded scenario and lands in a config kind obeys (extraMounts with a hostPath)
  if (!NODE_IMAGE_RE.test(nodeImage)) throw new Error(`cluster.nodeImage must look like kindest/node:vX.Y.Z, got ${JSON.stringify(String(nodeImage).slice(0, 80))}`);
  const roles = ["control-plane", ...Array.from({ length: Math.max(0, nodes - 1) }, () => "worker")];
  let worker = 0;
  const node = (r: string) => {
    const lines = [`  - role: ${r}`, `    image: ${JSON.stringify(nodeImage)}`];
    if (r === "worker") {
      const labels = workerLabels[worker++];
      if (labels && Object.keys(labels).length) {
        lines.push("    labels:");
        for (const [k, v] of Object.entries(labels)) lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
      }
    }
    return lines.join("\n");
  };
  return ["kind: Cluster", "apiVersion: kind.x-k8s.io/v1alpha4", "nodes:", ...roles.map(node), ""].join("\n");
}

/** shell heredoc that materialises the kubeconfig (and manifests) inside a runner/tools container */
export function kubeconfigPreamble(kubeconfig: string, dir = "/tmp/wom"): string {
  const eof = "__WOM_KUBECONFIG__";
  if (kubeconfig.includes(eof)) throw new Error("kubeconfig contains the heredoc marker");
  return `mkdir -p ${dir}
cat > ${dir}/kubeconfig <<'${eof}'
${kubeconfig}
${eof}
chmod 600 ${dir}/kubeconfig
export KUBECONFIG=${dir}/kubeconfig
`;
}

export function manifestsPreamble(manifests: { name: string; content: string }[], dir = "/tmp/wom/manifests"): string {
  let s = `mkdir -p ${dir}\n`;
  manifests.forEach((m, i) => {
    const eof = `__WOM_MANIFEST_${i}__`;
    if (m.content.includes(eof)) throw new Error("manifest contains the heredoc marker");
    const safe = m.name.replace(/[^A-Za-z0-9._-]/g, "_");
    s += `cat > ${dir}/${String(i).padStart(2, "0")}-${safe} <<'${eof}'\n${m.content}\n${eof}\n`;
  });
  return s;
}

export class KubernetesRuntimeProvider implements RuntimeProvider {
  private kindBin: string;
  private toolsImage: string;
  private clusterWaitSec: number;
  private env: NodeJS.ProcessEnv;
  private nodeLimits = kindNodeLimits();
  private cacheDir?: string;
  private cacheMaxBytes: number;
  private swept?: Promise<void>;
  private clusterCache: { at: number; names: Set<string> } | null = null;
  private clusterLookup: Promise<Set<string>> | null = null;
  private clusterGeneration = 0;

  constructor(
    private docker: DockerRuntimeProvider,
    opts: KubernetesProviderOptions = {},
  ) {
    this.cacheDir = opts.imageCacheDir ?? (process.env.WOM_IMAGE_CACHE_DIR || undefined);
    const maxMb = Number(process.env.WOM_IMAGE_CACHE_MAX_MB);
    this.cacheMaxBytes = opts.imageCacheMaxBytes ?? (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 10240) * 1024 * 1024;
    this.kindBin = opts.kindBin ?? "kind";
    this.toolsImage = opts.toolsImage ?? "wom-tools:dev";
    this.clusterWaitSec = opts.clusterWaitSec ?? 180;
    this.env = { ...process.env, DOCKER_HOST: opts.dockerHost ?? `unix://${docker.socketPath}` };
  }

  /** signal: abort kills the kind process (the session was killed mid-create; nobody waits for this cluster any more) */
  private kind(args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 300_000, signal?: AbortSignal) {
    return execFileP(this.kindBin, args, { env: { ...this.env, ...extraEnv }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal });
  }

  async ping(): Promise<void> {
    await this.kind(["version"]);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const k = spec.kubernetes;
    if (!k) throw new Error("KubernetesRuntimeProvider needs spec.kubernetes");
    // built first: a rejected nodeImage must fail before anything is created
    const config = kindConfig(k.nodes, k.nodeImage, k.workerLabels);
    const sessionId = spec.labels[SESSION_LABEL] ?? String(Date.now());
    const clusterName = `${KIND_CLUSTER_PREFIX}${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    const labels = { ...spec.labels, [PROVIDER_LABEL]: "kubernetes" };
    // kind nodes need a gateway (their entrypoint programs iptables with it), which docker `internal` networks lack:
    // the cluster network is a plain per-session bridge whose interface is named wk8s<id>; the egress guard drops every
    // connection such a bridge starts towards other interfaces (no internet, no LAN, no host services): R-7.
    const bridgeName = `wk8s${sessionId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-11)}`;
    const net = await this.docker.createInternalNetwork(clusterName, labels, { internal: false, bridgeName });
    const handle: SandboxHandle = { provider: "kubernetes", containerId: "", networkId: net.id, ownsNetwork: true, clusterName };
    /** checked between the phases; the long steps themselves take the signal */
    const stopIfAborted = () => {
      if (spec.signal?.aborted) throw new ProvisioningAborted();
    };
    try {
      stopIfAborted();
      // 1. cluster on the private network (kind honours KIND_EXPERIMENTAL_DOCKER_NETWORK)
      spec.onProgress?.("cluster");
      const configPath = path.join(os.tmpdir(), `${clusterName}.yaml`);
      const kubeconfigPath = path.join(os.tmpdir(), `${clusterName}.kubeconfig`);
      await fs.writeFile(configPath, config, { mode: 0o600 });
      try {
        await this.kind(
          ["create", "cluster", "--name", clusterName, "--config", configPath, "--wait", `${this.clusterWaitSec}s`, "--kubeconfig", kubeconfigPath, ...(process.env.WOM_KIND_RETAIN ? ["--retain"] : [])],
          { KIND_EXPERIMENTAL_DOCKER_NETWORK: net.name },
          (this.clusterWaitSec + 120) * 1000,
          spec.signal,
        );
      } catch (err) {
        stopIfAborted();
        throw new Error(`kind create cluster failed: ${(err as { stderr?: string }).stderr?.slice(-800) ?? String(err)}`);
      } finally {
        this.forgetClusters(); // the cluster exists now (or half of it does): a list taken before is stale
        await fs.rm(configPath, { force: true });
        await fs.rm(kubeconfigPath, { force: true });
      }
      await this.limitNodes(clusterName);
      const { stdout: kubeconfig } = await this.kind(["get", "kubeconfig", "--internal", "--name", clusterName]);
      handle.kubeconfig = kubeconfig;

      // 2. images the manifests need. Scenario images are built locally; public ones (postgres, nginx…) are pulled by the
      //    sandbox daemon on demand, then loaded into the node (kind nodes never pull themselves)
      if (k.images.length) spec.onProgress?.("images");
      let publicBytes = 0;
      for (const img of k.images) {
        stopIfAborted();
        const size = await this.ensureImage(img);
        if (!isPlatformImage(img)) publicBytes += size;
        if (publicBytes > PUBLIC_IMAGES_MAX_BYTES) throw new Error(`public images of the scenario exceed ${PUBLIC_IMAGES_MAX_BYTES / 1024 ** 3} GiB`);
      }
      for (const img of k.images) {
        stopIfAborted();
        await this.loadImage(img, clusterName, spec.signal);
      }
      stopIfAborted();

      // 3. tools container = the user's terminal, on the cluster network, kubeconfig in the on-call user's home
      spec.onProgress?.("tools");
      const tools = await this.docker.create({
        ...spec,
        kubernetes: undefined,
        onProgress: undefined,
        networkId: net.id,
        tmpfs: { ...DEFAULT_TMPFS, ...spec.tmpfs },
        labels: { ...labels, [ROLE_LABEL]: "tools" },
      });
      handle.containerId = tools.containerId;
      const home = "/home/oncall";
      const seed = await this.docker.runScript(
        tools,
        `#!/bin/sh
set -e
u=$(getent passwd | awk -F: '$3>=1000 && $1!="nobody"{print $1; exit}')
h=$(getent passwd "$u" | cut -d: -f6); [ -n "$h" ] || h=${home}
mkdir -p "$h/.kube"
cat > "$h/.kube/config" <<'__KC__'
${kubeconfig}__KC__
chown -R "$u" "$h/.kube"; chmod 600 "$h/.kube/config"
echo "kubeconfig -> $h/.kube/config ($u)"`,
        { user: "root", timeoutMs: 30_000, signal: spec.signal },
      );
      stopIfAborted();
      if (seed.exitCode !== 0) throw new Error(`seeding kubeconfig into the tools container failed: ${seed.stderr.slice(0, 300)}`);

      // 4. manifests via a runner (the orchestrator itself never talks to the apiserver)
      if (k.manifests.length) {
        spec.onProgress?.("manifests");
        const r = await this.runScript(
          handle,
          `#!/bin/sh
set -e
${manifestsPreamble(k.manifests)}
kubectl apply -f /tmp/wom/manifests
# best effort: give workloads a chance to come up before break.sh runs
kubectl wait --for=condition=Available deployment --all --all-namespaces --timeout=120s >/dev/null 2>&1 || true`,
          { user: "root", timeoutMs: 240_000, signal: spec.signal },
        );
        stopIfAborted();
        if (r.exitCode !== 0) throw new Error(`applying manifests failed: ${(r.stderr || r.stdout).slice(-600)}`);
      }
      return handle;
    } catch (err) {
      // WOM_KIND_RETAIN=1: keep the failed cluster/network for debugging (docker logs <cluster>-control-plane)
      if (!process.env.WOM_KIND_RETAIN) await this.destroy(handle).catch(() => {});
      throw err;
    }
  }

  /** best effort: a daemon that cannot apply a limit (no cgroup delegation) must not take kubernetes scenarios down,
   *  so a failure is only reported */
  private async limitNodes(clusterName: string): Promise<void> {
    const d = this.docker.docker;
    const report = (err: unknown) => console.error(`kind node limits not applied to ${clusterName}: ${err instanceof Error ? err.message : String(err)}`);
    try {
      const nodes = await d.listContainers({ all: true, filters: { label: [`io.x-k8s.kind.cluster=${clusterName}`] } });
      if (!nodes.length) report("no node containers found");
      for (const n of nodes) {
        try {
          // a controller the daemon lacks is not an error for it: the limit is dropped and only named in Warnings
          const res = (await d.getContainer(n.Id).update(this.nodeLimits)) as { Warnings?: string[] | null } | undefined;
          if (res?.Warnings?.length) report(res.Warnings.join("; "));
        } catch (err) {
          report(err);
        }
      }
    } catch (err) {
      report(err);
    }
  }

  /** break/check/solve: ephemeral runner container with the admin kubeconfig; never the user's tools container */
  async runScript(h: SandboxHandle, script: string, opts: ScriptOptions): Promise<ExecResult> {
    if (!h.kubeconfig) throw new Error("handle has no kubeconfig");
    const runner = await this.docker.create({
      image: this.toolsImage,
      writable: [],
      tmpfs: { "/tmp": "size=64m", "/run": "size=8m" },
      capAdd: RUNNER_CAPS,
      sudo: false,
      resources: { cpus: 1, memoryMb: 256, pids: 128 },
      networkId: h.networkId,
      labels: { [SESSION_LABEL]: h.clusterName?.slice(KIND_CLUSTER_PREFIX.length) ?? "", [OWNER_LABEL]: "orchestrator", [PROVIDER_LABEL]: "kubernetes", [ROLE_LABEL]: "runner" },
    });
    try {
      const body = script.replace(/^#!.*\n/, "");
      return await this.docker.runScript(runner, `${kubeconfigPreamble(h.kubeconfig)}${body}`, { user: "root", timeoutMs: opts.timeoutMs, signal: opts.signal });
    } finally {
      await this.docker.destroy({ ...runner, ownsNetwork: false }).catch(() => {});
    }
  }

  openTerminal(h: SandboxHandle, opts: TerminalOptions): Promise<TerminalStream> {
    return this.docker.openTerminal(h, { ...opts, env: [...(opts.env ?? []), "KUBECONFIG=/home/oncall/.kube/config"] });
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    const clusters = await this.clusterNames();
    if (h.clusterName && !clusters.has(h.clusterName)) return "missing";
    return h.containerId ? this.docker.status(h) : "running";
  }

  async destroy(h: SandboxHandle): Promise<void> {
    this.forgetClusters();
    if (h.clusterName) {
      await this.kind(["delete", "cluster", "--name", h.clusterName], {}, 120_000).catch(() => {});
      // a hung or failed `kind delete` leaves privileged node containers running, and the network cannot be removed
      // under them: whatever kind did not take down goes by force
      await this.removeNodes(h.clusterName);
    }
    // tools + any leftover runner of this session
    const sessionId = h.clusterName?.slice(KIND_CLUSTER_PREFIX.length);
    if (sessionId) {
      for (const c of await this.docker.listContainers([`${SESSION_LABEL}=${sessionId}`, `${PROVIDER_LABEL}=kubernetes`])) {
        await this.docker.destroy({ ...c.handle, ownsNetwork: false }).catch(() => {});
      }
    } else if (h.containerId) {
      await this.docker.destroy({ ...h, ownsNetwork: false }).catch(() => {});
    }
    this.forgetClusters();
    // Not swallowed: a network that stays holds an address range, and the caller has to know the destroy was incomplete.
    // The reconciler's orphan-network sweep removes what is left.
    if (h.ownsNetwork !== false && h.networkId) {
      await this.docker.removeNetwork(h.networkId).catch((err) => {
        console.error(`network ${h.networkId} of ${h.clusterName ?? "a sandbox"} was not removed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      });
    }
  }

  private async removeNodes(clusterName: string): Promise<void> {
    const d = this.docker.docker;
    try {
      const nodes = await d.listContainers({ all: true, filters: { label: [`io.x-k8s.kind.cluster=${clusterName}`] } });
      for (const n of nodes) {
        await d.getContainer(n.Id).remove({ force: true, v: true }).catch((err) => {
          if ((err as { statusCode?: number }).statusCode !== 404) console.error(`kind node ${n.Id.slice(0, 12)} of ${clusterName} survived forced removal: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      console.error(`kind nodes of ${clusterName} could not be listed for removal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** tools containers (one per session) plus clusters that have no tools container at all (crashed mid-create) */
  async list(): Promise<ListedSandbox[]> {
    const containers = (await this.docker.listContainers([`${PROVIDER_LABEL}=kubernetes`])).filter((c) => c.labels[ROLE_LABEL] === "tools");
    const out: ListedSandbox[] = containers.map((c) => ({
      ...c,
      handle: { ...c.handle, provider: "kubernetes", clusterName: c.sessionId ? `${KIND_CLUSTER_PREFIX}${c.sessionId}` : undefined, ownsNetwork: true },
    }));
    const seen = new Set(out.map((c) => c.sessionId));
    // clusters without a tools container: crashed mid-create, or a CLI cluster (`wom scenario test|run`, sessionId test-*/run-*)
    const nodes = await this.docker.docker.listContainers({ all: true, filters: { label: ["io.x-k8s.kind.cluster"] } });
    const createdByCluster = new Map<string, number>();
    for (const n of nodes) {
      const c = n.Labels?.["io.x-k8s.kind.cluster"];
      if (c) createdByCluster.set(c, Math.min(createdByCluster.get(c) ?? Infinity, n.Created * 1000));
    }
    for (const name of await this.clusterNames()) {
      if (!name.startsWith(KIND_CLUSTER_PREFIX)) continue;
      const sessionId = name.slice(KIND_CLUSTER_PREFIX.length);
      if (seen.has(sessionId)) continue;
      const cli = /^(test|run)-/.test(sessionId);
      out.push({
        handle: { provider: "kubernetes", containerId: "", networkId: name, ownsNetwork: true, clusterName: name },
        sessionId,
        createdAt: new Date(createdByCluster.get(name) ?? 0),
        labels: { [PROVIDER_LABEL]: "kubernetes", [OWNER_LABEL]: cli ? "cli" : "orchestrator" },
      });
    }
    return out;
  }

  /** `kind load docker-image` breaks on multi-platform images with the containerd image store (Docker 28+):
   *  the saved archive references foreign-platform blobs that are not present ("ctr: content digest … not found").
   *  Saving explicitly for linux/amd64 and loading the archive avoids that; older CLIs fall back to a plain save. */
  private async loadImage(img: string, clusterName: string, signal?: AbortSignal): Promise<void> {
    let archive: string | undefined;
    let cached = false;
    try {
      await (this.swept ??= this.sweepArchives());
      if (this.cacheDir) {
        try {
          archive = await this.cachedArchive(img, this.cacheDir, signal);
          cached = true;
        } catch (err) {
          // a cache that cannot be used must not take the session down: save into the temp dir as without it
          if (signal?.aborted) throw new ProvisioningAborted();
          console.error(`image cache not used for ${img}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!archive) {
        archive = path.join(os.tmpdir(), `wom-img-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`);
        await this.saveArchive(img, archive, signal);
      }
      await this.kind(["load", "image-archive", archive, "--name", clusterName], {}, 600_000, signal);
    } catch (err) {
      if (signal?.aborted) throw new ProvisioningAborted();
      throw new Error(`loading ${img} into the cluster failed: ${(err as { stderr?: string }).stderr?.slice(-400) ?? String(err)}`);
    } finally {
      if (archive && !cached) await fs.rm(archive, { force: true });
    }
  }

  private async saveArchive(img: string, dest: string, signal?: AbortSignal): Promise<void> {
    const opts = { env: this.env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024, signal };
    try {
      await execFileP("docker", ["save", "--platform", "linux/amd64", "-o", dest, img], opts);
    } catch {
      if (signal?.aborted) throw new ProvisioningAborted();
      await execFileP("docker", ["save", "-o", dest, img], opts);
    }
  }

  /** archives are keyed by the image id (content-addressed), so a rebuilt or re-pulled tag never hits a stale file */
  private async cachedArchive(img: string, dir: string, signal?: AbortSignal): Promise<string> {
    const id = String((await this.docker.docker.getImage(img).inspect()).Id).replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`unexpected image id ${JSON.stringify(id.slice(0, 80))}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.tar`);
    const now = new Date();
    try {
      await fs.utimes(file, now, now); // the use counts for the LRU order and for the grace period
      return file;
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    const part = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.part`;
    try {
      await this.saveArchive(img, part, signal);
      await fs.rename(part, file);
    } catch (err) {
      await fs.rm(part, { force: true });
      throw err;
    }
    await this.evictArchives(dir, file).catch((err) => console.error(`image cache eviction failed: ${err instanceof Error ? err.message : String(err)}`));
    return file;
  }

  private async evictArchives(dir: string, keep: string): Promise<void> {
    const files: { file: string; size: number; mtimeMs: number }[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".tar")) continue;
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st) files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    }
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= this.cacheMaxBytes) break;
      if (f.file === keep || Date.now() - f.mtimeMs < ARCHIVE_GRACE_MS) continue;
      await fs.rm(f.file, { force: true });
      total -= f.size;
    }
  }

  /** archives of sessions that died mid-load (a restart of the orchestrator) would otherwise stay in /tmp for good */
  private async sweepArchives(): Promise<void> {
    const sweep = async (dir: string, re: RegExp) => {
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!re.test(name)) continue;
        const file = path.join(dir, name);
        const st = await fs.stat(file).catch(() => null);
        if (st && Date.now() - st.mtimeMs > ARCHIVE_MAX_AGE_MS) await fs.rm(file, { force: true }).catch(() => {});
      }
    };
    await sweep(os.tmpdir(), /^wom-img-.*\.tar$/);
    if (this.cacheDir) await sweep(this.cacheDir, /\.part$/);
  }

  /** returns the image size in bytes; pulls only what pullDenial allows */
  private async ensureImage(img: string): Promise<number> {
    const d = this.docker.docker;
    try {
      return Number((await d.getImage(img).inspect()).Size) || 0;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    const denial = pullDenial(img);
    if (denial) throw new Error(denial);
    const stream = await d.pull(img);
    await new Promise<void>((resolve, reject) => d.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())));
    return Number((await d.getImage(img).inspect()).Size) || 0;
  }

  /**
   * Every call used to spawn `kind get clusters`, and the reconciler asks once per kubernetes session on every pass.
   * The answer is kept for a few seconds and shared by concurrent callers; create and destroy drop it. A failed call is
   * not kept (it reads as "no clusters").
   */
  private async clusterNames(): Promise<Set<string>> {
    if (this.clusterCache && Date.now() - this.clusterCache.at < CLUSTER_NAMES_TTL_MS) return this.clusterCache.names;
    this.clusterLookup ??= this.lookupClusters().finally(() => {
      this.clusterLookup = null;
    });
    return this.clusterLookup;
  }

  private async lookupClusters(): Promise<Set<string>> {
    const generation = this.clusterGeneration;
    try {
      const { stdout } = await this.kind(["get", "clusters"]);
      const names = new Set(stdout.split("\n").map((s) => s.trim()).filter(Boolean));
      // a create or destroy that finished while kind was answering has made this answer stale already
      if (generation === this.clusterGeneration) this.clusterCache = { at: Date.now(), names };
      return names;
    } catch {
      return new Set<string>();
    }
  }

  private forgetClusters() {
    this.clusterCache = null;
    this.clusterGeneration++;
  }
}
