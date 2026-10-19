// Scenario format v2 (ADR-0005). zod is the source of truth; schemas/wom.scenario.v2.json mirrors it for external tools.
import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/, "slug: lowercase letters, digits and dashes, 3-64 chars");
const absPath = z.string().regex(/^\/[^\0]*$/, "must be an absolute path");
// Mount points are compared with the immutable prefixes as plain strings, so they must already be in normal form:
// "/etc/../usr/bin" would pass a startsWith check and then mount over /usr/bin.
const mountPath = absPath.refine(
  (p) => p === "/" || p.slice(1).split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
  'path must be normalised: no empty, "." or ".." segments and no trailing slash',
);
/** a folder inside the scenario directory: it ends up in a docker build context and in file reads on the platform */
const folderPath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !/^[\\/]|^[a-zA-Z]:|\0/.test(p) && !p.split(/[\\/]/).includes(".."), 'must stay inside the scenario folder: a relative path without ".."');

// Image names end up in the kind config, in `docker pull` and in `kind load`, so they are held to the reference grammar:
// [registry[:port]/]path[:tag][@sha256:digest], lowercase, no whitespace, quotes or control characters.
export const IMAGE_REF_RE = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const imageRef = z.string().min(3).max(200).regex(IMAGE_REF_RE, "image: [registry/]name[:tag][@sha256:digest], lowercase, no spaces or quotes");
/** the node image of a cluster that does not name one */
export const DEFAULT_NODE_IMAGE = "kindest/node:v1.37.0";
/** the node image is pulled and run privileged by kind: only the official kindest/node releases */
const NODE_IMAGE_RE = /^kindest\/node:v\d+\.\d+\.\d+(?:@sha256:[0-9a-f]{64})?$/;

// Nested objects are strict too: a misspelt key ("memoryMB", "egres") would otherwise be dropped and the default would apply silently.
export const hintSchema = z
  .object({
    level: z.number().int().min(1).max(9),
    text: z.string().min(5).max(1000),
    penalty: z.number().int().min(0).max(100).default(0),
  })
  .strict();

export const serviceSchema = z
  .object({
    name: z.string().min(1).max(40),
    port: z.number().int().min(1).max(65535),
    kind: z.enum(["http", "tcp"]).default("tcp"),
  })
  .strict();

/** the longest brief, debrief, guide or script that gets into the database (characters); the linter reports the same limit */
export const MAX_TEXT_CHARS = 100_000;

export const environmentSchema = z
  .object({
    kind: z.enum(["container", "kubernetes", "compose"]).default("container"),
    /** container: the sandbox image; kubernetes: the tools image for the terminal (kubectl inside) */
    image: imageRef,
    /** kubernetes only (ADR-0008) */
    cluster: z
      .object({
        nodes: z.number().int().min(1).max(4).default(1),
        /** labels for worker nodes in order (e.g. topology.kubernetes.io/zone); the control-plane keeps kind's defaults */
        workerLabels: z.array(z.record(z.string().min(1), z.string().min(1))).max(3).optional(),
        nodeImage: z.string().regex(NODE_IMAGE_RE, "cluster.nodeImage: only kindest/node:vX.Y.Z (optionally @sha256:<digest>)").default(DEFAULT_NODE_IMAGE),
      })
      .strict()
      .optional(),
    /** kubernetes only: directory with *.yaml applied in name order (inlined by the loader) */
    manifests: folderPath.optional(),
    /** kubernetes only: images to `kind load` into the nodes (the cluster network has no egress) */
    images: z.array(imageRef).max(20).default([]),
    build: folderPath.optional(),
    setup: z.string().optional(),
    break: z.string().optional(),
    check: z.string(),
    solve: z.string(),
    ttlMin: z.number().int().min(5).max(240).default(45),
    resources: z
      .object({
        cpus: z.number().positive().max(4).default(1),
        memoryMb: z.number().int().min(64).max(4096).default(512),
        pids: z.number().int().min(16).max(4096).default(256),
      })
      .strict()
      .default({ cpus: 1, memoryMb: 512, pids: 256 }),
    network: z
      .object({
        egress: z.enum(["none", "allowlist"]).default("none"),
        allow: z.array(z.string()).max(50).default([]),
      })
      .strict()
      .default({ egress: "none", allow: [] }),
    services: z.array(serviceSchema).max(20).default([]),
    shell: z
      .object({
        user: z.string().min(1).max(32).default("root"),
        cwd: absPath.default("/"),
        shell: absPath.default("/bin/sh"),
        sudo: z.boolean().default(false),
      })
      .strict()
      .default({ user: "root", cwd: "/", shell: "/bin/sh", sudo: false }),
    hostname: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "hostname: RFC 1123 label")
      .optional(),
    writable: z.array(mountPath).max(20).default(["/etc", "/var", "/home", "/root"]),
    /** extra tmpfs mounts with a size limit: the honest way to simulate "disk full" (path -> "size=128m") */
    tmpfs: z.record(mountPath, z.string().regex(/^size=\d+[kmg]$/i, "tmpfs options: size=<n>[k|m|g]")).default({}),
    capabilities: z.array(z.string().regex(/^(?!CAP_)[A-Z][A-Z_]+$/, "capability name in upper case without the CAP_ prefix, e.g. NET_BIND_SERVICE")).max(20).optional(),
    /** what the player sees while the environment comes up: usual wait and, for heavy stacks, what is being started */
    startup: z
      .object({
        expectedSec: z.number().int().min(5).max(900).optional(),
        note: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    artifacts: z.array(z.object({ src: z.string().min(1), dest: absPath }).strict()).max(50).default([]),
  })
  .strict();

export const scenarioV2Schema = z
  .object({
    version: z.literal(2),
    slug,
    title: z.string().min(3).max(120),
    summary: z.string().min(10).max(2000),
    type: z.string().min(3).max(120),
    difficulty: z.enum(["JUNIOR", "MIDDLE", "SENIOR"]),
    durationMin: z.number().int().min(5).max(180),
    tags: z.array(z.string().regex(/^[a-z0-9-]{1,30}$/)).max(20).default([]),
    contextJson: jsonObject.default({}),
    eventsJson: z.array(jsonObject).max(200).default([]),
    hintsJson: z.array(hintSchema).max(9).default([]),
    actionsJson: z.array(jsonObject).max(200).default([]),
    gmScriptJson: jsonObject.nullable().default(null),
    brief: z.string().optional(),
    debrief: z.string().optional(),
    /** teaching scenarios: markdown split by `## ` headings into stages the player reveals one by one, penalty-free */
    guide: z.string().optional(),
    environment: environmentSchema.nullable().default(null),
    /** regression-test knobs: baseline = what the grader must say on the UNBROKEN environment */
    test: z
      .object({
        baseline: z.enum(["pass", "fail", "skip"]).default("pass"),
      })
      .strict()
      .default({ baseline: "pass" }),
  })
  .strict();

export type ScenarioV2 = z.infer<typeof scenarioV2Schema>;
export type EnvironmentV2 = z.infer<typeof environmentSchema>;

/**
 * R-4: the rootfs stays read-only and the binaries stay the image's own, so a writable volume or a tmpfs may not sit on
 * these (a writable volume would make them mutable, a tmpfs would hide them). The linter reports it to an author; the import
 * schema below enforces it for every record that reaches the database, whatever route it took.
 */
export const IMMUTABLE_PREFIXES = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev"];
export function isImmutableMount(p: string): boolean {
  return IMMUTABLE_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

/** a kubernetes manifest as it is stored: the loader inlines the folder, the file name is a bare *.yaml name */
const storedManifestSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/, "manifest name: a bare *.yaml file name"),
    // cert-manager's release manifest alone is about 1 MB; the request body limits bound the record as a whole
    content: z.string().max(2 * 1024 * 1024),
  })
  .strict();

/**
 * The environment as it is stored in Scenario.environmentJson and in an import record (publicEnvironment() output): the same
 * rules as the scenario file, minus the file references, plus the inlined manifests.
 */
export const publicEnvironmentSchema = environmentSchema
  .omit({ build: true, setup: true, break: true, check: true, solve: true, manifests: true })
  .extend({ manifests: z.array(storedManifestSchema).max(50).optional() })
  .superRefine((env, ctx) => {
    env.writable.forEach((p, i) => {
      if (p === "/") ctx.addIssue({ code: "custom", path: ["writable", i], message: "writable '/' defeats the read-only rootfs" });
      else if (isImmutableMount(p)) ctx.addIssue({ code: "custom", path: ["writable", i], message: `writable path ${p} would make binaries/libraries mutable (R-4)` });
    });
    for (const p of Object.keys(env.tmpfs)) {
      if (p === "/" || isImmutableMount(p)) ctx.addIssue({ code: "custom", path: ["tmpfs", p], message: `tmpfs on ${p} would hide binaries/libraries (R-4)` });
    }
  });
export type PublicEnvironmentV2 = z.infer<typeof publicEnvironmentSchema>;

/** v1 import file (wom-games, schemas/wom.scenario.v1.json): text-only scenarios */
export const scenarioV1Schema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(10).max(2000),
  type: z.string().min(3).max(120),
  difficulty: z.enum(["JUNIOR", "MIDDLE", "SENIOR"]).default("MIDDLE"),
  durationMin: z.number().int().min(5).max(180).default(20),
  contextJson: jsonObject.default({}),
  eventsJson: z.array(jsonObject).max(200).default([]),
  hintsJson: z.array(jsonObject).max(100).default([]),
  actionsJson: z.array(jsonObject).max(200).default([]),
  gmScriptJson: jsonObject.nullable().optional(),
});

/** scenario as it travels through the import endpoint / into the DB: files inlined, secrets separated */
export const importRecordSchema = z
  .object({
    slug,
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    title: z.string().min(3).max(120),
    summary: z.string().min(10).max(2000),
    type: z.string().min(3).max(120),
    difficulty: z.enum(["JUNIOR", "MIDDLE", "SENIOR"]),
    durationMin: z.number().int().min(5).max(180),
    tags: z.array(z.string().regex(/^[a-z0-9-]{1,30}$/)).max(20).default([]),
    contextJson: jsonObject,
    eventsJson: z.array(jsonObject).max(200),
    /** v1 hints keep the wom-games shape; a v2 record's hints are held to hintSchema (see the refinement below) */
    hintsJson: z.array(jsonObject).max(100),
    actionsJson: z.array(jsonObject).max(200),
    gmScriptJson: jsonObject.nullable(),
    briefMd: z.string().max(MAX_TEXT_CHARS).nullable(),
    debriefMd: z.string().max(MAX_TEXT_CHARS).nullable(),
    guideMd: z.string().max(MAX_TEXT_CHARS).nullable().default(null),
    /** environment without file references (image, resources, shell, …); null for text-only scenarios */
    environmentJson: publicEnvironmentSchema.nullable(),
    breakScript: z.string().max(MAX_TEXT_CHARS).nullable(),
    graderScript: z.string().max(MAX_TEXT_CHARS).nullable(),
    solutionScript: z.string().max(MAX_TEXT_CHARS).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.schemaVersion === 1) {
      // a v1 file is text-only: an environment or a script under that label would skip every v2 rule about them
      for (const k of ["environmentJson", "breakScript", "graderScript", "solutionScript"] as const) {
        if (r[k] !== null) ctx.addIssue({ code: "custom", path: [k], message: "a v1 record is text-only: no environment and no scripts" });
      }
      return;
    }
    if (r.hintsJson.length > 9) ctx.addIssue({ code: "custom", path: ["hintsJson"], message: "at most 9 hints" });
    r.hintsJson.forEach((h, i) => {
      const res = hintSchema.safeParse(h);
      if (!res.success) for (const issue of res.error.issues) ctx.addIssue({ code: "custom", path: ["hintsJson", i, ...issue.path], message: issue.message });
    });
  });
export type ImportRecord = z.infer<typeof importRecordSchema>;

export class ImportRecordError extends Error {
  constructor(public issues: string[]) {
    super(`invalid import record: ${issues[0] ?? "unknown"}`);
    this.name = "ImportRecordError";
  }
}

/**
 * The gate in front of the database (seed, POST /api/import, moderation approve): a record that is not a valid v1/v2 record
 * does not get in. It runs on input only; rows already stored are never re-validated when they are read.
 */
export function validateImportRecord(r: unknown): ImportRecord {
  const parsed = importRecordSchema.safeParse(r);
  if (!parsed.success) throw new ImportRecordError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  return parsed.data;
}

export const importFileV2Schema = z.object({
  version: z.literal(2),
  scenarios: z.array(importRecordSchema).min(1).max(100),
});
export const importFileV1Schema = z.object({
  scenarios: z.array(scenarioV1Schema).min(1).max(100),
});
