// environment (scenario v2, ADR-0005/0008) -> SandboxSpec (ADR-0001). Single source of truth for hardening defaults,
// shared by the orchestrator (real sessions) and the CLI (`wom scenario test|run`).
import { DEFAULT_CAPS, DEFAULT_TMPFS, DEFAULT_WRITABLE, OWNER_LABEL, SESSION_LABEL, type SandboxSpec } from "./types";

type EnvironmentCommon = {
  image: string;
  ttlMin?: number;
  resources?: { cpus?: number; memoryMb?: number; pids?: number };
  shell?: { user?: string; cwd?: string; shell?: string; sudo?: boolean };
  hostname?: string;
  writable?: string[];
  tmpfs?: Record<string, string>;
  capabilities?: string[];
  services?: { name: string; port: number; kind?: "http" | "tcp" }[];
  network?: { egress?: "none" | "allowlist"; allow?: string[] };
};

/** kubernetes only (ADR-0008): a kind cluster per session; `image` is then the tools image of the terminal */
export type KubernetesEnvironment = EnvironmentCommon & {
  kind: "kubernetes";
  cluster?: { nodes?: number; nodeImage?: string; workerLabels?: Record<string, string>[] };
  manifests?: { name: string; content: string }[];
  images?: string[];
};

/** one hardened container; "compose" passes the scenario schema but has no runtime yet, specFromEnvironment refuses it */
export type ContainerEnvironment = EnvironmentCommon & { kind?: "container" | "compose" };

/** what a scenario's environment looks like once it is stored (scenario v2, ADR-0005; the loader's schema is the source) */
export type Environment = ContainerEnvironment | KubernetesEnvironment;

const ENVIRONMENT_KINDS: readonly unknown[] = ["container", "kubernetes", "compose"];

/** The one place a stored environmentJson becomes an Environment: it passed the schema when it was imported, this only
 *  refuses a value of the wrong shape (a hand-edited row, an older format) instead of failing later on a missing field. */
export function parseEnvironment(json: unknown): Environment {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("environment must be an object");
  const e = json as Record<string, unknown>;
  if (e.kind !== undefined && !ENVIRONMENT_KINDS.includes(e.kind)) throw new Error(`environment kind ${JSON.stringify(e.kind)} is not known`);
  if (typeof e.image !== "string" || !e.image) throw new Error("environment.image is required");
  return json as Environment;
}

export const DEFAULT_NODE_IMAGE = "kindest/node:v1.37.0";
/** the only node images a scenario may name: the value lands in the kind config and is pulled by the sandbox daemon */
export const NODE_IMAGE_RE = /^kindest\/node:v\d+\.\d+\.\d+(@sha256:[0-9a-f]{64})?$/;

export function specFromEnvironment(env: Environment, sessionId: string, extraLabels: Record<string, string> = {}): SandboxSpec {
  if (env.kind !== undefined && env.kind !== "container" && env.kind !== "kubernetes") throw new Error(`environment kind '${env.kind}' is not supported yet`);
  if (!env.image) throw new Error("environment.image is required");
  const spec: SandboxSpec = {
    image: env.image,
    hostname: env.hostname,
    writable: env.writable ?? DEFAULT_WRITABLE,
    tmpfs: { ...DEFAULT_TMPFS, ...(env.tmpfs ?? {}) },
    capAdd: env.capabilities ?? DEFAULT_CAPS,
    sudo: env.shell?.sudo ?? false,
    resources: {
      cpus: env.resources?.cpus ?? 1,
      memoryMb: env.resources?.memoryMb ?? 512,
      pids: env.resources?.pids ?? 256,
    },
    labels: { [SESSION_LABEL]: sessionId, [OWNER_LABEL]: "orchestrator", ...extraLabels },
  };
  if (env.kind === "kubernetes") {
    spec.kubernetes = {
      nodes: env.cluster?.nodes ?? 1,
      nodeImage: env.cluster?.nodeImage ?? DEFAULT_NODE_IMAGE,
      workerLabels: env.cluster?.workerLabels,
      manifests: env.manifests ?? [],
      images: env.images ?? [],
    };
  }
  return spec;
}

export function shellFromEnvironment(env: { shell?: Environment["shell"] }): { user: string; shell: string; cwd: string } {
  return {
    user: env.shell?.user ?? "root",
    shell: env.shell?.shell ?? "/bin/sh",
    cwd: env.shell?.cwd ?? "/",
  };
}
