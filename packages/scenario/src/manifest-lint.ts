// Content rules for the kubernetes manifests of a scenario. All of them are warnings: a manifest may break things on purpose
// (that is the incident), but the author should know what the platform will do with it.
import YAML from "yaml";
import type { LintIssue } from "./lint";

/** a kind node container gets this much (packages/runtime kindNodeLimits defaults); the cluster has `nodes` of them */
export const KIND_NODE_MEMORY_MIB = 4096;
export const KIND_NODE_CPUS = 2;
/** manifests above this size in total are not parsed here: the size rule of the linter already refuses them */
export const MANIFESTS_PARSE_MAX_BYTES = 4 * 1024 * 1024;

const MEMORY_UNITS: Record<string, number> = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };

/** a Kubernetes quantity in the unit of its resource: CPU cores for "250m", bytes for "128Mi"; null if it is not a quantity */
export function parseQuantity(value: unknown, kind: "cpu" | "memory"): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const m = /^(\d+(?:\.\d+)?|\.\d+)(?:[eE](\d+))?([A-Za-z]*)$/.exec(value.trim());
  if (!m) return null;
  const base = Number(m[1]) * (m[2] ? 10 ** Number(m[2]) : 1);
  if (kind === "cpu") return m[3] === "" ? base : m[3] === "m" ? base / 1000 : null;
  const unit = MEMORY_UNITS[m[3]];
  return unit === undefined ? null : base * unit;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** the pod template of a workload and how many pods of it run */
function podOf(doc: Obj, nodes: number): { spec: Obj; pods: number; name: string } | null {
  const kind = typeof doc.kind === "string" ? doc.kind : "";
  const spec = isObj(doc.spec) ? doc.spec : {};
  const meta = isObj(doc.metadata) ? doc.metadata : {};
  const name = `${kind}/${typeof meta.name === "string" ? meta.name : "?"}`;
  const count = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
  const template = (s: Obj) => (isObj(s.template) && isObj(s.template.spec) ? s.template.spec : null);
  let podSpec: Obj | null = null;
  let pods = 1;
  if (kind === "Pod") podSpec = spec;
  else if (kind === "Deployment" || kind === "StatefulSet" || kind === "ReplicaSet" || kind === "ReplicationController") {
    podSpec = template(spec);
    pods = count(spec.replicas, 1);
  } else if (kind === "DaemonSet") {
    podSpec = template(spec);
    pods = nodes;
  } else if (kind === "Job") {
    podSpec = template(spec);
    pods = count(spec.parallelism, 1);
  } else if (kind === "CronJob") {
    const job = isObj(spec.jobTemplate) && isObj(spec.jobTemplate.spec) ? spec.jobTemplate.spec : null;
    podSpec = job ? template(job) : null;
  }
  return podSpec ? { spec: podSpec, pods, name } : null;
}

const fmtMiB = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MiB`;
const fmtCpu = (cores: number) => `${Math.round(cores * 1000)}m`;

/** is the line at `index` explained by a comment: at its end, or in the comment lines right above it */
function hasReason(lines: string[], index: number): boolean {
  const words = (s: string) => /[\p{L}\d]{2,}\s+[\p{L}\d]{2,}/u.test(s);
  const inline = lines[index].indexOf(" #");
  if (inline >= 0 && words(lines[index].slice(inline + 2))) return true;
  for (let j = index - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!t.startsWith("#")) return false;
    if (words(t.slice(1))) return true;
  }
  return false;
}

/** what widens a pod's reach to the node: it needs a stated reason next to it, otherwise it reads as a copied snippet */
const RISKY = [
  { re: /\bprivileged:\s*true\b/, rule: "manifest-privileged", what: "privileged: true" },
  { re: /\bhostPath:/, rule: "manifest-host-access", what: "a hostPath volume" },
  { re: /\bhost(?:Network|PID|IPC):\s*true\b/, rule: "manifest-host-access", what: "host namespace sharing" },
];

export function lintManifests(
  files: { name: string; content: string }[],
  opts: { nodes: number; isFloating: (ref: string) => boolean },
): LintIssue[] {
  const out: LintIssue[] = [];
  const warn = (rule: string, message: string) => out.push({ level: "warning", rule, message });
  const total = files.reduce((a, f) => a + f.content.length, 0);

  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    const unexplained = new Map<(typeof RISKY)[number], number[]>();
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const r of RISKY) {
        if (r.re.test(line) && !hasReason(lines, i)) unexplained.set(r, [...(unexplained.get(r) ?? []), i + 1]);
      }
    });
    for (const [r, at] of unexplained) {
      const shown = at.slice(0, 5).join(", ") + (at.length > 5 ? ` and ${at.length - 5} more` : "");
      warn(r.rule, `${f.name}: ${r.what} without a comment that says why (line ${shown}); the player is cluster-admin, so a pod with it reaches the node`);
    }
  }
  if (total > MANIFESTS_PARSE_MAX_BYTES) return out;

  let memory = 0;
  let cpu = 0;
  const floating = new Set<string>();
  for (const f of files) {
    let docs: unknown[];
    try {
      const parsed = YAML.parseAllDocuments(f.content);
      const bad = parsed.find((d) => d.errors.length);
      if (bad) throw bad.errors[0];
      docs = parsed.map((d) => d.toJS({ maxAliasCount: 100 }));
    } catch (e) {
      warn("manifest-yaml", `${f.name}: cannot be parsed as YAML (${(e as Error).message.split("\n")[0]}); the content rules were skipped for it`);
      continue;
    }
    const bare: string[] = [];
    for (const doc of docs) {
      if (!isObj(doc)) continue;
      const pod = podOf(doc, opts.nodes);
      if (!pod) continue;
      for (const c of arr(pod.spec.containers)) {
        if (!isObj(c)) continue;
        const resources = isObj(c.resources) ? c.resources : {};
        if (!isObj(resources.requests) || !isObj(resources.limits)) bare.push(`${pod.name}:${typeof c.name === "string" ? c.name : "?"}`);
        if (isObj(resources.requests)) {
          memory += (parseQuantity(resources.requests.memory, "memory") ?? 0) * pod.pods;
          cpu += (parseQuantity(resources.requests.cpu, "cpu") ?? 0) * pod.pods;
        }
      }
      for (const c of [...arr(pod.spec.containers), ...arr(pod.spec.initContainers)]) {
        if (isObj(c) && typeof c.image === "string" && opts.isFloating(c.image)) floating.add(c.image);
      }
    }
    if (bare.length) {
      const shown = bare.slice(0, 5).join(", ") + (bare.length > 5 ? ` and ${bare.length - 5} more` : "");
      warn("manifest-resources", `${f.name}: containers without resources.requests or resources.limits: ${shown}; without them the scheduler cannot place the pod by its size and one pod can take the whole node`);
    }
  }
  for (const ref of floating) {
    warn("manifest-image-unpinned", `manifests: image ${ref} has no tag or uses :latest; pin a version (or @sha256:) so the regression stays reproducible`);
  }
  const capMemory = KIND_NODE_MEMORY_MIB * 1024 ** 2 * opts.nodes;
  const capCpu = KIND_NODE_CPUS * opts.nodes;
  if (memory > capMemory || cpu > capCpu) {
    warn(
      "manifest-requests-budget",
      `resource requests of all pods add up to ${fmtMiB(memory)} and ${fmtCpu(cpu)}; ${opts.nodes} kind node(s) have ${KIND_NODE_MEMORY_MIB} MiB and ${KIND_NODE_CPUS} CPU each, so some pods would stay Pending`,
    );
  }
  return out;
}
