// RuntimeProvider (ADR-0001): the only abstraction between the platform and how sandboxes are run.
// DockerRuntimeProvider = one hardened container (ADR-0001). KubernetesRuntimeProvider = a kind cluster per session
// plus a hardened tools container as the user's terminal (ADR-0008). RuntimeRegistry dispatches between them.

export type SandboxResources = { cpus: number; memoryMb: number; pids: number };

export type KubernetesSpec = {
  /** labels applied to worker nodes in order (kind node config `labels`) */
  workerLabels?: Record<string, string>[];
  /** number of kind nodes (1 = single control-plane; 2-3 adds workers) */
  nodes: number;
  nodeImage: string;
  /** manifests applied after the cluster is up, in order */
  manifests: { name: string; content: string }[];
  /** images to `kind load` into the nodes (the cluster network has no egress) */
  images: string[];
};

export type SandboxSpec = {
  image: string;
  hostname?: string;
  /** paths that become anonymous volumes seeded from the image; everything else is read-only */
  writable: string[];
  /** tmpfs mounts: path -> mount options ("size=64m") */
  tmpfs: Record<string, string>;
  /** capabilities added back after cap-drop ALL */
  capAdd: string[];
  /** true => no-new-privileges is NOT set (setuid sudo must work) */
  sudo: boolean;
  resources: SandboxResources;
  labels: Record<string, string>;
  /** attach to this existing docker network instead of creating a private one (used for tools/runner containers) */
  networkId?: string;
  /** present => KubernetesRuntimeProvider: `image` is then the tools image for the terminal sandbox */
  kubernetes?: KubernetesSpec;
  /** provisioning phases as they start, for the player's waiting screen (best effort, never awaited) */
  onProgress?: (phase: SandboxPhase) => void;
  /** aborted when the session is killed while its sandbox is still being created: providers stop long steps
   *  (cluster create, image load, manifests) right away instead of finishing work nobody will use */
  signal?: AbortSignal;
};

/** signal: abort => the script's stream is dropped and the result is exitCode -1 (the caller destroys the sandbox) */
export type ScriptOptions = { user: string; timeoutMs: number; signal?: AbortSignal };

/** thrown by providers when SandboxSpec.signal fires mid-create */
export class ProvisioningAborted extends Error {
  constructor() {
    super("provisioning aborted");
    this.name = "ProvisioningAborted";
  }
}

export type SandboxPhase = "sandbox" | "cluster" | "images" | "tools" | "manifests";

export type SandboxHandle = {
  provider: "docker" | "kubernetes";
  /** the container the terminal attaches to (the sandbox itself, or the tools container for kubernetes) */
  containerId: string;
  networkId: string;
  /** false => destroy() leaves the network alone (someone else owns it) */
  ownsNetwork?: boolean;
  clusterName?: string;
  /** internal kubeconfig (apiserver reachable on networkId); admin of a throwaway cluster */
  kubeconfig?: string;
};

export type SandboxStatus = "running" | "exited" | "missing";

/**
 * stdout and stderr are the tail of the output (the last 256 KiB of each). outputTooLarge: the script printed more than
 * the hard cap, the stream was dropped and exitCode is -1; whatever was kept is only a tail, never a verdict.
 */
export type ExecResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; outputTooLarge?: boolean };

export type TerminalOptions = { user: string; shell: string; cwd: string; cols: number; rows: number; env?: string[] };

export interface TerminalStream {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): Promise<void>;
  end(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onEnd(cb: () => void): void;
  // Flow control. Optional: with a provider that lacks it the terminal gateway can only drop output on overflow.
  /** stop reading the sandbox output: the process writing it blocks instead of a buffer growing on our side */
  pause?(): void;
  resume?(): void;
  /** false while input written to the sandbox piles up unread (a process that ignores its stdin); see onDrain */
  writable?(): boolean;
  /** cb runs every time the piled-up input has been taken and writing may go on */
  onDrain?(cb: () => void): void;
}

export type ListedSandbox = { handle: SandboxHandle; sessionId: string | null; createdAt: Date; labels: Record<string, string> };

export interface RuntimeProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** run a script delivered over stdin (never written to the sandbox disk, ADR-0004) */
  runScript(h: SandboxHandle, script: string, opts: ScriptOptions): Promise<ExecResult>;
  openTerminal(h: SandboxHandle, opts: TerminalOptions): Promise<TerminalStream>;
  status(h: SandboxHandle): Promise<SandboxStatus>;
  destroy(h: SandboxHandle): Promise<void>;
  /** every sandbox this provider knows about, for the reconciler */
  list(): Promise<ListedSandbox[]>;
}

export const SANDBOX_LABEL = "wom.platform";
export const SANDBOX_LABEL_VALUE = "sandbox";
export const SESSION_LABEL = "wom.session";
/** who created the sandbox: "orchestrator" (a TrainingSession) or "cli" (`wom scenario test|run`); the reconciler leaves cli sandboxes alone for a while */
export const OWNER_LABEL = "wom.owner";
/** which provider owns a container: "docker" (plain sandbox) or "kubernetes" (tools/runner container of a kind session) */
export const PROVIDER_LABEL = "wom.provider";
/** role of a kubernetes-session container: "tools" (user terminal) or "runner" (ephemeral script executor) */
export const ROLE_LABEL = "wom.role";
export const CLI_SANDBOX_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const KIND_CLUSTER_PREFIX = "wom-k8s-";

/** system directories no scenario may make writable or mount a tmpfs over (R-4: no installing over the binaries). Mirrors IMMUTABLE_PREFIXES of @wom/scenario; a test keeps them equal. */
export const IMMUTABLE_PREFIXES = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev"];
export const isImmutablePath = (p: string): boolean => IMMUTABLE_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));

export const DEFAULT_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "NET_BIND_SERVICE", "SETPCAP"];
export const DEFAULT_WRITABLE = ["/etc", "/var", "/home", "/root"];
export const DEFAULT_TMPFS = { "/tmp": "size=64m", "/run": "size=16m" };

/** hard denies that no scenario can override (ADR-0001) */
export const FORBIDDEN_CAPS = new Set(["SYS_ADMIN", "NET_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO", "DAC_READ_SEARCH", "MKNOD", "SYS_BOOT", "SYS_TIME", "BPF", "PERFMON", "ALL"]);

/** Docker trims, upper-cases and accepts an optional CAP_ prefix, so "SYS_ADMIN", "cap_sys_admin" and " CAP_SYS_ADMIN"
 *  are one capability: FORBIDDEN_CAPS must be checked against (and Docker given) this canonical form only */
export function normalizeCapability(cap: string): string {
  return String(cap).trim().toUpperCase().replace(/^(CAP_)+/, "");
}
