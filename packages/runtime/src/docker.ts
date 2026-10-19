import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { summarizeDockerDf, type DockerDiskUsage } from "./disk-usage";
import { SCRIPT_OUTPUT_LIMIT_BYTES, SCRIPT_OUTPUT_TAIL_BYTES, TailBuffer } from "./output-limit";
import {
  FORBIDDEN_CAPS,
  isImmutablePath,
  normalizeCapability,
  ProvisioningAborted,
  PROVIDER_LABEL,
  SANDBOX_LABEL,
  SANDBOX_LABEL_VALUE,
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

function is404(err: unknown) {
  return (err as { statusCode?: number }).statusCode === 404;
}

// Graders run as root in a sandbox whose /root, /etc and /dev the player can write (ADR-0004, R-4), so their HOME
// lives on the read-only rootfs: the directory exists only as the parent of the platform mount below.
const GRADER_HOME = "/nonexistent";

// The only mounts a sandbox ever gets from outside, and they do not break the "no host mounts" rule (ADR-0001):
// the source is the constant /dev/null (never a scenario value, no host data behind it) and the mount is read-only,
// exactly what runc does for masked paths. A mountpoint cannot be unlinked, renamed or written by the player.
//  - /etc/ld.so.preload: the loader would otherwise preload a player's library into every grader process (ADR-0004);
//  - $GRADER_HOME/.curlrc: curl falls back to the passwd home (~root/.curlrc) unless it finds a config under CURL_HOME.
const PLATFORM_MOUNTS = ["/etc/ld.so.preload", `${GRADER_HOME}/.curlrc`].map((Target) => ({
  Type: "bind" as const,
  Source: "/dev/null",
  Target,
  ReadOnly: true,
}));

// $0 is the deadline in seconds; the script itself still arrives over stdin (ADR-0004)
const SCRIPT_SHELL = 'if command -v timeout >/dev/null 2>&1; then exec timeout -s KILL "$0" /bin/sh -s; fi; exec /bin/sh -s';

export class DockerRuntimeProvider implements RuntimeProvider {
  readonly docker: Docker;

  constructor(readonly socketPath: string) {
    this.docker = new Docker({ socketPath });
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  /** private network for one session; internal (no egress, ADR-0001) unless the caller needs a gateway (kind nodes do) */
  async createInternalNetwork(
    name: string,
    labels: Record<string, string>,
    opts: { internal?: boolean; bridgeName?: string } = {},
  ): Promise<{ id: string; name: string }> {
    const net = await this.docker.createNetwork({
      Name: name,
      Internal: opts.internal ?? true,
      Labels: { ...labels, [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE },
      // a predictable bridge interface name lets the egress guard (images/egress-guard) match session bridges (R-7)
      ...(opts.bridgeName ? { Options: { "com.docker.network.bridge.name": opts.bridgeName } } : {}),
    });
    return { id: net.id, name };
  }

  async removeNetwork(idOrName: string): Promise<void> {
    await this.docker.getNetwork(idOrName).remove().catch((err) => {
      if (!is404(err)) throw err;
    });
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.signal?.aborted) throw new ProvisioningAborted();
    spec.onProgress?.("sandbox");
    const capAdd = spec.capAdd.map((cap) => {
      const name = normalizeCapability(cap);
      if (!/^[A-Z_]+$/.test(name)) throw new Error(`capability ${JSON.stringify(cap)} is not a capability name`);
      if (FORBIDDEN_CAPS.has(name)) throw new Error(`capability ${cap} is forbidden for sandboxes`);
      return name;
    });
    for (const p of [...spec.writable, ...Object.keys(spec.tmpfs)]) {
      if (!p.startsWith("/") || p.includes("..") || isImmutablePath(p)) throw new Error(`path ${p} cannot be writable or a tmpfs in a sandbox`);
    }
    const labels = { ...spec.labels, [SANDBOX_LABEL]: SANDBOX_LABEL_VALUE };
    const ownsNetwork = !spec.networkId;
    const networkId = spec.networkId ?? (await this.createInternalNetwork(`wom-sb-${spec.labels[SESSION_LABEL] ?? Date.now()}`, labels)).id;
    let container: Docker.Container;
    try {
      const volumes: Record<string, object> = {};
      for (const p of spec.writable) volumes[p] = {};
      container = await this.docker.createContainer({
        Image: spec.image,
        Hostname: spec.hostname,
        Labels: labels,
        Volumes: volumes,
        HostConfig: {
          NetworkMode: networkId,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          CapAdd: capAdd,
          SecurityOpt: spec.sudo ? [] : ["no-new-privileges"],
          Memory: spec.resources.memoryMb * 1024 * 1024,
          MemorySwap: spec.resources.memoryMb * 1024 * 1024,
          NanoCpus: Math.round(spec.resources.cpus * 1e9),
          PidsLimit: spec.resources.pids,
          Tmpfs: spec.tmpfs,
          // hard denies regardless of scenario: no host mounts, no privileged, no host network (ADR-0001)
          Privileged: false,
          Binds: [],
          Mounts: PLATFORM_MOUNTS,
        },
      });
      await container.start();
    } catch (err) {
      if (ownsNetwork) await this.removeNetwork(networkId).catch(() => {});
      throw err;
    }
    return { provider: "docker", containerId: container.id, networkId, ownsNetwork };
  }

  async runScript(h: SandboxHandle, script: string, opts: ScriptOptions & { env?: string[] }): Promise<ExecResult> {
    if (opts.signal?.aborted) return { exitCode: -1, stdout: "", stderr: "aborted", timedOut: false };
    const container = this.docker.getContainer(h.containerId);
    const exec = await container.exec({
      // Dropping the stream on a timeout does not stop the exec'ed process, so the deadline is enforced inside the
      // sandbox as well, a second later: the timer below stays the one that reports the timeout. An image without
      // timeout(1) keeps the old behaviour instead of failing every script.
      Cmd: ["/bin/sh", "-c", SCRIPT_SHELL, String(Math.ceil(opts.timeoutMs / 1000) + 1)],
      User: opts.user,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      // clean environment for graders (ADR-0004): no user PATH/LD_PRELOAD influence and no rc files from the writable
      // /root. PSQLRC is a path nobody can create rather than /dev/null: psql also tries "<PSQLRC>-<version>", and
      // /dev is a writable tmpfs
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `HOME=${GRADER_HOME}`,
        "LD_PRELOAD=",
        `PSQLRC=${GRADER_HOME}/.psqlrc`,
        `CURL_HOME=${GRADER_HOME}`,
        ...(opts.env ?? []),
      ],
    });
    const startedAt = Date.now();
    const stream = await exec.start({ hijack: true, stdin: true, Tty: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outTail = new TailBuffer(SCRIPT_OUTPUT_TAIL_BYTES);
    const errTail = new TailBuffer(SCRIPT_OUTPUT_TAIL_BYTES);
    stdout.on("data", (c: Buffer) => outTail.push(c));
    stderr.on("data", (c: Buffer) => errTail.push(c));
    // The cap counts what comes off the socket, before demuxing: a frame header announcing gigabytes makes the demuxer
    // itself hold everything it has read. The process in the sandbox is not stopped by this (see the deadline above).
    let outputTooLarge = false;
    let received = 0;
    stream.on("data", (c: Buffer) => {
      received += c.length;
      if (received > SCRIPT_OUTPUT_LIMIT_BYTES && !outputTooLarge) {
        outputTooLarge = true;
        stream.destroy();
      }
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);

    let timedOut = false;
    const done = new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", resolve);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy();
    }, opts.timeoutMs);
    // the session was killed: stop waiting for the script; whoever aborted destroys the container (and the script with it)
    const onAbort = () => stream.destroy();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    stream.write(script.endsWith("\n") ? script : script + "\n");
    stream.end(); // EOF -> sh -s finishes reading the script
    await done;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    // a stalled event loop lets timeout(1) in the sandbox win the race: the script was still killed at its deadline
    if (!opts.signal?.aborted && Date.now() - startedAt >= opts.timeoutMs) timedOut = true;

    let exitCode = -1;
    if (!timedOut && !outputTooLarge && !opts.signal?.aborted) {
      const info = await exec.inspect().catch(() => null);
      exitCode = info?.ExitCode ?? -1;
    }
    return {
      exitCode,
      stdout: outTail.toString(),
      stderr: errTail.toString(),
      timedOut,
      ...(outputTooLarge ? { outputTooLarge } : {}),
    };
  }

  async openTerminal(h: SandboxHandle, opts: TerminalOptions): Promise<TerminalStream> {
    const container = this.docker.getContainer(h.containerId);
    const exec = await container.exec({
      Cmd: [opts.shell, "-l"],
      User: opts.user,
      WorkingDir: opts.cwd,
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: ["TERM=xterm-256color", ...(opts.env ?? [])],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    await exec.resize({ w: opts.cols, h: opts.rows }).catch(() => {});
    return {
      write: (data) => {
        stream.write(data);
      },
      resize: (cols, rows) => exec.resize({ w: cols, h: rows }).then(() => undefined),
      end: () => stream.end(),
      onData: (cb) => stream.on("data", cb),
      onEnd: (cb) => {
        stream.on("end", cb);
        stream.on("close", cb);
        stream.on("error", cb);
      },
      // the stream is the hijacked daemon socket: not reading it makes the daemon stop reading the pty, which blocks
      // the process in the sandbox; a full write buffer means the sandbox is not taking its stdin
      pause: () => {
        stream.pause();
      },
      resume: () => {
        stream.resume();
      },
      writable: () => !stream.writableNeedDrain,
      onDrain: (cb) => {
        stream.on("drain", cb);
      },
    };
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    try {
      const info = await this.docker.getContainer(h.containerId).inspect();
      return info.State.Running ? "running" : "exited";
    } catch (err) {
      if (is404(err)) return "missing";
      throw err;
    }
  }

  async destroy(h: SandboxHandle): Promise<void> {
    if (h.containerId) {
      await this.docker.getContainer(h.containerId).remove({ force: true, v: true }).catch((err) => {
        if (!is404(err)) throw err;
      });
    }
    if (h.ownsNetwork !== false) await this.removeNetwork(h.networkId);
  }

  /** sandbox containers of THIS provider (containers of kubernetes sessions carry wom.provider=kubernetes and are listed there) */
  async list(): Promise<ListedSandbox[]> {
    return (await this.listContainers()).filter((c) => c.labels[PROVIDER_LABEL] !== "kubernetes");
  }

  async listContainers(extraLabelFilters: string[] = []): Promise<ListedSandbox[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${SANDBOX_LABEL}=${SANDBOX_LABEL_VALUE}`, ...extraLabelFilters] },
    });
    const out: ListedSandbox[] = [];
    for (const c of containers) {
      const networkId = Object.values(c.NetworkSettings?.Networks ?? {})[0]?.NetworkID ?? "";
      out.push({
        handle: { provider: "docker", containerId: c.Id, networkId },
        sessionId: c.Labels?.[SESSION_LABEL] ?? null,
        createdAt: new Date(c.Created * 1000),
        labels: c.Labels ?? {},
      });
    }
    return out;
  }

  /**
   * Networks left behind without a container (a crash between createNetwork and createContainer, a destroy that could
   * not remove its network). minAgeMs > 0 spares the young ones: a network is empty for a while before its first
   * container joins, and a network whose age cannot be read is spared too. Only networks actually removed are counted.
   */
  async removeOrphanNetworks(minAgeMs = 0, now = Date.now()): Promise<number> {
    const nets = await this.docker.listNetworks({ filters: { label: [`${SANDBOX_LABEL}=${SANDBOX_LABEL_VALUE}`] } });
    let removed = 0;
    for (const n of nets) {
      const full = await this.docker.getNetwork(n.Id).inspect().catch(() => null);
      if (!full || Object.keys(full.Containers ?? {}).length !== 0) continue;
      if (minAgeMs > 0) {
        const created = Date.parse(String(full.Created ?? n.Created ?? ""));
        if (!Number.isFinite(created) || now - created < minAgeMs) continue;
      }
      try {
        await this.docker.getNetwork(n.Id).remove();
        removed++;
      } catch (err) {
        if (!is404(err)) console.error(`orphan network ${n.Name ?? n.Id.slice(0, 12)} was not removed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return removed;
  }

  /** images and build cache on the daemon's disk, for the periodic log line (one `docker system df`: it walks every image, not for a hot path) */
  async diskUsage(): Promise<DockerDiskUsage> {
    return summarizeDockerDf(await this.docker.df());
  }

  /**
   * Address pools the daemon allocates network subnets from. Empty = the built-in defaults (172.17-31.0.0/16, then
   * 192.168.x.0/20), which run out after about 30 networks: every session has its own.
   */
  async defaultAddressPools(): Promise<{ Base: string; Size: number }[]> {
    const info = (await this.docker.info()) as { DefaultAddressPools?: { Base: string; Size: number }[] | null };
    return info.DefaultAddressPools ?? [];
  }
}
