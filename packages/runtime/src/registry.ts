// RuntimeRegistry: one RuntimeProvider facade over docker + kubernetes, dispatching by spec/handle.
import type { ExecResult, ListedSandbox, RuntimeProvider, SandboxHandle, SandboxSpec, SandboxStatus, ScriptOptions, TerminalOptions, TerminalStream } from "./types";

/**
 * disabled = no kubernetes provider is configured; ready = the last `kind version` answered; unavailable = the provider is
 * configured but kind does not answer (the binary is missing, the daemon environment is broken). Sessions that already
 * run on kubernetes must not be judged by a provider that cannot report on them.
 */
export type KubernetesState = "disabled" | "ready" | "unavailable";

/** what the registry offers beyond RuntimeProvider; the reconciler uses it when the runtime it was given has it */
export interface RuntimeExtras {
  kubernetesState(): KubernetesState;
  /** pings kind (up to `attempts` times, `delayMs` apart) and updates the state; concurrent callers share one probe */
  probeKubernetes(opts?: { attempts?: number; delayMs?: number }): Promise<KubernetesState>;
  /** docker networks of sandboxes that have no container and are older than minAgeMs; returns how many were removed */
  removeOrphanNetworks(minAgeMs: number): Promise<number>;
}

type DockerSide = RuntimeProvider & { removeOrphanNetworks?(minAgeMs: number): Promise<number> };
type KubernetesSide = RuntimeProvider & { ping?(): Promise<void> };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RuntimeRegistry implements RuntimeProvider, RuntimeExtras {
  private k8sState: KubernetesState;
  private probing: Promise<KubernetesState> | null = null;
  /** why the last probe failed, for the error a refused create carries */
  private k8sError = "";

  // The methods are async on purpose: a handle that no configured provider can serve must be a rejected promise.
  // A synchronous throw escapes the `.catch()` the callers put on the call.
  constructor(private providers: { docker: DockerSide; kubernetes?: KubernetesSide }) {
    this.k8sState = providers.kubernetes ? "ready" : "disabled";
  }

  kubernetesState(): KubernetesState {
    return this.k8sState;
  }

  probeKubernetes(opts: { attempts?: number; delayMs?: number } = {}): Promise<KubernetesState> {
    const k = this.providers.kubernetes;
    if (!k) return Promise.resolve("disabled");
    if (!k.ping) return Promise.resolve(this.k8sState);
    this.probing ??= this.runProbe(k.ping.bind(k), Math.max(1, opts.attempts ?? 1), opts.delayMs ?? 2000).finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async runProbe(ping: () => Promise<void>, attempts: number, delayMs: number): Promise<KubernetesState> {
    for (let i = 1; i <= attempts; i++) {
      try {
        await ping();
        this.k8sState = "ready";
        this.k8sError = "";
        return "ready";
      } catch (err) {
        this.k8sError = err instanceof Error ? err.message : String(err);
        if (i < attempts) await sleep(delayMs);
      }
    }
    this.k8sState = "unavailable";
    return "unavailable";
  }

  private byHandle(h: SandboxHandle): RuntimeProvider {
    if (h.provider === "kubernetes") {
      if (!this.providers.kubernetes) throw new Error("kubernetes runtime is not configured");
      return this.providers.kubernetes;
    }
    return this.providers.docker;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.kubernetes) {
      const k = this.providers.kubernetes;
      if (!k) throw new Error("kubernetes runtime is not configured (KIND_BIN)");
      // it may have come back since the last look: one cheap probe before a player is told no
      if (this.k8sState === "unavailable" && (await this.probeKubernetes()) !== "ready") {
        throw new Error(`kubernetes runtime is unavailable: kind does not answer (${this.k8sError.slice(0, 200)})`);
      }
      return k.create(spec);
    }
    return this.providers.docker.create(spec);
  }
  async runScript(h: SandboxHandle, script: string, opts: ScriptOptions): Promise<ExecResult> {
    return this.byHandle(h).runScript(h, script, opts);
  }
  async openTerminal(h: SandboxHandle, opts: TerminalOptions): Promise<TerminalStream> {
    return this.byHandle(h).openTerminal(h, opts);
  }
  async status(h: SandboxHandle): Promise<SandboxStatus> {
    return this.byHandle(h).status(h);
  }
  async destroy(h: SandboxHandle): Promise<void> {
    return this.byHandle(h).destroy(h);
  }
  /** kubernetes sandboxes are left out while kind is unavailable: the caller must not read their absence as "gone" (see kubernetesState) */
  async list(): Promise<ListedSandbox[]> {
    const k = this.k8sState === "ready" ? this.providers.kubernetes : undefined;
    const lists = await Promise.all([this.providers.docker.list(), k?.list() ?? Promise.resolve([])]);
    return lists.flat();
  }

  async removeOrphanNetworks(minAgeMs: number): Promise<number> {
    return (await this.providers.docker.removeOrphanNetworks?.(minAgeMs)) ?? 0;
  }
}
