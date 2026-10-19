// Lint rules beyond the schema: the "honest break" contract and platform constraints (ADR-0001/0004/0005).
import { readFileSync } from "node:fs";
import path from "node:path";
import { FORBIDDEN_CAPS } from "@wom/runtime";
import { isDirectory, isFile, manifestFileNames, readManifests, REFERENCE_SECTIONS, splitGuide, TUTORIAL_SUFFIX, type ScenarioBundle } from "./load";
import { lintManifests } from "./manifest-lint";
import { IMAGE_REF_RE, isImmutableMount, MAX_TEXT_CHARS } from "./schema";

export type LintIssue = { level: "error" | "warning"; rule: string; message: string };

const PACKAGE_MANAGERS = ["apt-get", "apt ", "dpkg", "apk ", "yum ", "dnf ", "pip ", "pip3 "];
/** the moderation build runs on the production daemon: a scenario image may only start from these (extend deliberately) */
export const ALLOWED_BASE_IMAGES = ["debian:bookworm-slim", "python:3.12-alpine", "alpine:3.22", "alpine:3.20"];

/** registries a scenario may load images from into a cluster; Docker Hub is spelled without a host */
export const ALLOWED_REGISTRIES = ["docker.io", "registry.k8s.io", "quay.io", "ghcr.io"];
/** the break script of a live scenario has to fit into what the grader environment gives it */
export const BREAK_BUDGET_SEC = 240;
const MEMORY_WARN_MB = 1024;
const MEMORY_MAX_MB = 2048;
/** the manifests of one scenario, all files together (cert-manager's release manifest alone is about 1 MB) */
const MANIFESTS_MAX_BYTES = 4 * 1024 * 1024;
/** the free-form JSON of scenario.yaml (context, events, actions, GM script) */
const META_JSON_MAX_CHARS = 256 * 1024;

/** the registry a reference is pulled from: the first path part counts as a host only if it looks like one */
export function registryOf(ref: string): string {
  const first = ref.split("/")[0];
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
}

const withoutDigest = (ref: string) => ref.replace(/@sha256:[0-9a-f]{64}$/, "");
/** no tag or :latest and no digest: the image behind the name changes under the regression */
export function isFloatingImage(ref: string): boolean {
  if (/@sha256:[0-9a-f]{64}$/.test(ref)) return false;
  const tag = /:([^/:]+)$/.exec(ref)?.[1];
  return !tag || tag === "latest";
}

/** a mount path the way the kernel sees it: "/etc/../usr/bin" is /usr/bin, "/usr//" is /usr */
function normalMount(p: string): string {
  const n = path.posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/**
 * Worst-case seconds break.sh spends in its longest wait, read off its loops: a counter loop costs bound x sleeps per round,
 * a loop on the wall clock (elapsed, date +%s, SECONDS) costs its deadline. Sleeps outside loops add up; `--timeout=` waits of
 * kubectl are not counted (they end with `|| true` as a rule).
 * Loops are not summed: one that runs out ends the script with an error, so the budget is about a single wait that is too long.
 * A heuristic: a bound it cannot see counts as nothing.
 */
export function breakWaitBudgetSec(script: string): number {
  const lines = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const sleeps = (text: string) => [...text.matchAll(/(?:^[ \t]*|[;&|(]\s*|\bdo\s+)sleep\s+(\d+(?:\.\d+)?)/gm)].reduce((a, m) => a + Number(m[1]), 0);
  let plain = 0;
  let longest = 0;
  let depth = 0;
  let loop: string[] = [];
  const closeLoop = () => {
    const text = loop.join("\n");
    const bounds = [...text.matchAll(/-(?:lt|le|ge|gt)\s+(\d+)\b/g)].map((m) => Number(m[1]));
    const seq = /\bseq\s+(?:\d+\s+)?(\d+)\b/.exec(text);
    if (seq) bounds.push(Number(seq[1]));
    const bound = Math.max(0, ...bounds);
    const wallClock = /\b(?:elapsed|SECONDS)\b|date\s+\+%s/.test(text);
    longest = Math.max(longest, wallClock ? bound : bound * sleeps(text));
  };
  for (const line of lines) {
    const starts = (line.match(/(?:^\s*|[;&|(]\s*|\b(?:do|then|else)\s+)(?:while|until|for)\s/g) ?? []).length;
    const dones = (line.match(/(?:^\s*|[;&|]\s*)done\b/g) ?? []).length;
    if (depth === 0 && starts === 0) {
      plain += sleeps(line);
      continue;
    }
    loop.push(line);
    depth += starts - dones;
    if (depth <= 0) {
      depth = 0;
      closeLoop();
      loop = [];
    }
  }
  if (loop.length) closeLoop();
  return Math.round(plain + longest);
}

/** image references in manifests: `image:` fields and controller flags like `--acme-http01-solver-image=…` */
export function manifestImages(yaml: string): string[] {
  const found = new Set<string>();
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/(?:^\s*(?:-\s+)?|[{,]\s*)["']?image["']?:\s*["']?([^\s"'#,}]+)/g)) found.add(m[1]);
    for (const m of line.matchAll(/--[a-z0-9-]*image=["']?([^\s"',\]]+)/g)) found.add(m[1]);
  }
  // templated values ($IMAGE, {{ … }}) cannot be resolved here
  return [...found].filter((ref) => IMAGE_REF_RE.test(ref));
}

/** the name containerd resolves a reference to: "nginx:1.27" and "docker.io/library/nginx:1.27" are one image */
function canonicalImage(ref: string): string {
  const short = ref.replace(/^docker\.io\//, "").replace(/^library\//, "");
  return /[:@][^/]*$/.test(short) ? short : `${short}:latest`;
}

/**
 * Everything a Dockerfile makes the builder pull: FROM, COPY/RUN `from=` and a custom frontend; stages defined earlier are fine.
 * The file is read twice, line by line and with continuations glued the way the builder does it ("FR\" + "OM image" is a FROM),
 * and whatever either reading finds is reported.
 */
export function disallowedDockerfileImages(dockerfile: string): string[] {
  const raw = dockerfile.split("\n").map((l) => l.replace(/\r+$/, ""));
  const glued: string[] = [];
  let open = false;
  for (const line of raw) {
    // the builder drops comment and empty lines, also in the middle of a continued instruction
    if (/^[\s\u0085]*(#|$)/.test(line)) continue;
    const continues = /(^|[^\\])\\[ \t]*$/.test(line);
    const text = continues ? line.replace(/\\[ \t]*$/, "") : line;
    if (open) glued[glued.length - 1] += text;
    else glued.push(text);
    open = continues;
  }
  const bad = new Set<string>();
  let sawFrom = false;
  for (const lines of [raw, glued]) {
    // a name counts as a stage only after its FROM: used earlier, the builder takes it for an image and pulls it
    const stages = new Set<string>();
    const allowed = (ref: string) => ALLOWED_BASE_IMAGES.includes(ref.replace(/@sha256:[0-9a-f]{64}$/, "")) || stages.has(ref.toLowerCase());
    for (const line of lines) {
      // U+0085 is whitespace for the Dockerfile parser but not for \s
      const from = /^[\s\u0085]*FROM[\s\u0085]+(.*)$/i.exec(line);
      if (from) {
        sawFrom = true;
        const t = from[1].split(/[\s\u0085]+/).filter((x) => x && !x.startsWith("--"));
        if (!t[0] || !allowed(t[0])) bad.add(t[0] ?? "(empty FROM)");
        if (t[1]?.toLowerCase() === "as" && /^[a-z][a-z0-9_.-]*$/i.test(t[2] ?? "")) stages.add(t[2].toLowerCase());
      }
      for (const m of line.matchAll(/(?:--|[,=])from=([^\s,]+)/gi)) if (!/^\d+$/.test(m[1]) && !allowed(m[1])) bad.add(m[1]);
    }
  }
  // without a FROM the file is not a Dockerfile: the builder also accepts a JSON document that only names a frontend image
  if (!sawFrom) bad.add("(no FROM instruction)");
  // `syntax` hands the build to an arbitrary frontend image (the `//` spelling works too), `escape` changes what a continuation is
  // a FROM split by a continuation inside the keyword is reported as is: gluing can be thrown off (a heredoc that ends in a backslash)
  for (const line of raw) if (/^[\s\u0085]*(?:(?:#|\/\/)\s*(?:syntax|escape)\s*=|(?:F|FR|FRO|FROM)\\[ \t]*$)/i.test(line)) bad.add(line.trim());
  return [...bad];
}

// `command -v psql` is a lookup, "psql недоступен" is a message: a call is the bare tool name followed by an argument
const NOT_A_LOOKUP = String.raw`(?<!\b(?:command -v|which|type|hash)[ \t]+)(?<![\w.-])`;
const ARGS_FOLLOW = String.raw`[ \t]+(?=[-\w$"'/.:{<])`;

/** client tools in a grader that would read the player's rc files (/root and /home are writable, so the output can be faked) */
export function graderRcFileReaders(check: string): ("psql" | "curl")[] {
  const code = check
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const out: ("psql" | "curl")[] = [];
  const psql = [...code.matchAll(new RegExp(`${NOT_A_LOOKUP}psql${ARGS_FOLLOW}([^|;&)\\n]*)`, "g"))];
  if (psql.some((m) => !/(?:^|\s)(?:-[A-Za-z]*X[A-Za-z]*|--no-psqlrc)(?=\s|$)/.test(m[1]))) out.push("psql");
  // curl honours -q only as the very first argument
  const curl = [...code.matchAll(new RegExp(`${NOT_A_LOOKUP}curl${ARGS_FOLLOW}(\\S+)`, "g"))];
  if (curl.some((m) => m[1] !== "-q" && m[1] !== "--disable")) out.push("curl");
  return out;
}

export function lintBundle(b: ScenarioBundle): LintIssue[] {
  const out: LintIssue[] = [];
  const err = (rule: string, message: string) => out.push({ level: "error", rule, message });
  const warn = (rule: string, message: string) => out.push({ level: "warning", rule, message });
  const m = b.meta;
  const env = m.environment;

  // hints: contiguous levels 1..n, penalties non-decreasing
  const levels = m.hintsJson.map((h) => h.level).sort((a, c) => a - c);
  levels.forEach((lvl, i) => {
    if (lvl !== i + 1) err("hints-contiguous", `hint levels must be 1..n without gaps, got ${levels.join(",")}`);
  });
  for (let i = 1; i < m.hintsJson.length; i++) {
    if (m.hintsJson[i].penalty < m.hintsJson[i - 1].penalty) warn("hints-penalty-order", "hint penalties should not decrease with level");
  }
  if (env && m.hintsJson.length < 3) warn("hints-three-levels", "live scenarios should have 3 hints: direction, tool, near-answer");

  if (!env) return out; // text-only scenario: nothing else to check

  if (env.kind === "compose") err("kind-unsupported", "environment.kind 'compose' is not supported in this version (owner decision: single container for MVP)");
  if (env.kind === "kubernetes") {
    const mdir = env.manifests ? path.join(b.dir, env.manifests) : null;
    if (!mdir || !isDirectory(mdir)) err("k8s-manifests", "kubernetes scenarios need environment.manifests: a directory with *.yaml");
    else if (!manifestFileNames(mdir).length) err("k8s-manifests", `no *.yaml in ${env.manifests}`);
    else {
      // kind nodes get only `images` (kind load) and have no egress: anything else ends in ImagePullBackOff when a session starts
      try {
        const listed = new Set(env.images.map(canonicalImage));
        const listedFloating = new Set(env.images.filter(isFloatingImage).map(canonicalImage));
        const files = readManifests(b.dir, env.manifests!);
        for (const f of files) {
          for (const ref of manifestImages(f.content)) {
            if (!ref.startsWith("wom-scenario/") && !listed.has(canonicalImage(ref))) err("k8s-images-listed", `${f.name}: image ${ref} is not in environment.images; list every image, including the ones controllers start themselves`);
          }
        }
        const bytes = files.reduce((a, f) => a + f.content.length, 0);
        if (bytes > MANIFESTS_MAX_BYTES) err("manifests-size", `manifests add up to ${Math.round(bytes / 1024)} KB; the limit is ${MANIFESTS_MAX_BYTES / 1024} KB`);
        // an image already reported for the `images` list is not reported again
        out.push(...lintManifests(files, { nodes: env.cluster?.nodes ?? 1, isFloating: (ref) => isFloatingImage(ref) && !listedFloating.has(canonicalImage(ref)) }));
      } catch (e) {
        err("k8s-manifests", (e as Error).message);
      }
    }
    if (env.build && !env.images.length) err("k8s-build", "environment.build in a kubernetes scenario builds images[0] (the scenario app image): list it in `images`");
    for (const name of ["check", "solve"] as const) {
      const text = b.scripts[name];
      if (text && !/kubectl/.test(text)) warn("k8s-kubectl", `${name}.sh does not use kubectl; graders of kubernetes scenarios run in a runner container with KUBECONFIG set`);
    }
    if (env.shell.user === "root") warn("k8s-shell-user", "tools container terminal as root; use the oncall user (kubeconfig is placed in the first uid>=1000 home)");
  }
  if (env.kind !== "kubernetes" && (env.manifests || env.images.length || env.cluster)) warn("k8s-fields", "manifests/images/cluster are only used when environment.kind = kubernetes");

  // referenced files exist
  for (const [key, rel] of Object.entries({ brief: m.brief, debrief: m.debrief, guide: m.guide, setup: env.setup, break: env.break, check: env.check, solve: env.solve })) {
    if (rel && !isFile(path.join(b.dir, rel))) err("file-missing", `${key}: file not found: ${rel}`);
  }
  // what ends up in the database row: the texts, the scripts and the free-form JSON are held to a size
  for (const [what, text] of Object.entries({ brief: b.briefMd, debrief: b.debriefMd, guide: b.guideMd, "break.sh": b.scripts.break, "check.sh": b.scripts.check, "solve.sh": b.scripts.solve })) {
    if (text && text.length > MAX_TEXT_CHARS) err("text-too-large", `${what} has ${text.length} characters; the limit is ${MAX_TEXT_CHARS}`);
  }
  const metaChars = JSON.stringify([m.contextJson, m.eventsJson, m.actionsJson, m.gmScriptJson]).length;
  if (metaChars > META_JSON_MAX_CHARS) err("text-too-large", `contextJson, eventsJson, actionsJson and gmScriptJson add up to ${metaChars} characters; the limit is ${META_JSON_MAX_CHARS}`);
  for (const key of ["infra", "setup", "time"]) {
    if (m.contextJson[key] !== undefined && typeof m.contextJson[key] !== "string") warn("context-shape", `contextJson.${key} must be a string: the scenario card shows only strings and skips this one`);
  }
  if (m.contextJson.services !== undefined && !(Array.isArray(m.contextJson.services) && m.contextJson.services.every((x) => typeof x === "string"))) {
    warn("context-shape", "contextJson.services must be a list of strings: the scenario card shows only strings and skips this one");
  }
  // read by nothing yet: a declared service looks like it is checked or exposed, and is not
  if (env.services.length) warn("services-unsupported", "environment.services is not used by the platform yet: the ports are not published or checked; describe the services in the brief instead");
  if (env.artifacts.length) err("artifacts-unsupported", "environment.artifacts is not copied by the platform; bake the files into the image");
  if (!m.brief) err("brief-required", "live scenarios need a brief (what the on-call engineer sees)");
  if (!m.debrief) err("debrief-required", "live scenarios need a debrief (what was broken, reference solution)");
  // teaching format: stages are revealed one by one, so the guide must be split by `## ` headings
  if (m.guide && b.guideMd !== null && splitGuide(b.guideMd).length === 0) err("guide-stages", `${m.guide}: no stages found; every stage starts with a '## ' heading`);
  if (m.guide) {
    if (m.difficulty !== "JUNIOR") warn("guide-junior", "scenarios with a guide.md are the teaching format: set difficulty JUNIOR");
    const brief = b.briefMd ?? "";
    if (!/^>\s*🎓/m.test(brief)) warn("tutorial-brief-parts", "the brief of a teaching scenario starts with a '> 🎓' callout (it goes to the teaching copy only)");
    const headings = new Set([...brief.matchAll(/^##\s+(.+?)\s*$/gm)].map((h) => h[1].trim()));
    for (const name of REFERENCE_SECTIONS) {
      if (!headings.has(name)) warn("tutorial-brief-parts", `the brief of a teaching scenario needs a '## ${name}' section`);
    }
  }
  if (m.tags.includes("tutorial")) warn("tutorial-tag", "tag 'tutorial' is added automatically to the teaching copy; drop it from scenario.yaml");
  if (m.slug.endsWith(TUTORIAL_SUFFIX)) err("slug-reserved", "slug must not end with '" + TUTORIAL_SUFFIX + "': that suffix is reserved for the teaching copy generated from guide.md");
  const buildEscapes = !!env.build && !(path.resolve(b.dir, env.build) + path.sep).startsWith(path.resolve(b.dir) + path.sep);
  if (buildEscapes) err("build-escapes", `environment.build must stay inside the scenario folder, got ${env.build}`);
  else if (env.build && !isFile(path.join(b.dir, env.build, "Dockerfile"))) err("build-dockerfile", `environment.build: no Dockerfile in ${env.build}`);
  else if (env.build) {
    for (const ref of disallowedDockerfileImages(readFileSync(path.join(b.dir, env.build, "Dockerfile"), "utf8"))) {
      err("image-base", `Dockerfile pulls ${ref}; allowed base images: ${ALLOWED_BASE_IMAGES.join(", ")} (earlier stages of the same Dockerfile are fine, '# syntax=' and '# escape=' are not)`);
    }
  }
  // images built from a scenario folder are namespaced by slug, so two authors can never overwrite each other's tag
  if (env.build) {
    const tag = env.kind === "kubernetes" ? (env.images[0] ?? env.image) : env.image;
    if (!tag.startsWith(`wom-scenario/${m.slug}:`)) err("image-tag-namespace", `built image must be tagged wom-scenario/${m.slug}:<tag>, got ${tag}`);
  }

  // The sandbox starts any image the daemon has, and kind loads whatever `images` names: both are held to this scenario's own images
  // and to public registries, otherwise an author gets a terminal in somebody else's (or the platform's) image.
  const ownImages = `wom-scenario/${m.slug}:`;
  if (env.kind === "kubernetes") {
    if (!env.image.startsWith("wom-tools:")) err("image-source", `kubernetes scenarios use the platform tools image: environment.image must be wom-tools:<tag>, got ${env.image}`);
  } else if (!env.build && !env.image.startsWith(ownImages) && !ALLOWED_BASE_IMAGES.includes(withoutDigest(env.image))) {
    err("image-source", `environment.image must be ${ownImages}<tag> (built with environment.build) or one of ${ALLOWED_BASE_IMAGES.join(", ")}, got ${env.image}`);
  }
  for (const ref of env.images) {
    // the daemon reads "docker.io/library/wom-tools:dev" as the local wom-tools:dev, so the host and "library/" are dropped before the namespace is looked at
    const local = ref.replace(/^docker\.io\//, "").replace(/^library\//, "");
    if (local.startsWith("wom-scenario/")) {
      if (!local.startsWith(ownImages)) err("image-source", `images: ${ref} belongs to another scenario; only ${ownImages}<tag> and public images are allowed`);
      continue;
    }
    if (local.startsWith("wom-")) {
      err("image-source", `images: ${ref} is an image of the platform itself; only ${ownImages}<tag> and public images are allowed`);
      continue;
    }
    if (!ALLOWED_REGISTRIES.includes(registryOf(ref))) err("image-registry", `images: ${ref} comes from a registry outside the allowlist (${ALLOWED_REGISTRIES.join(", ")})`);
    if (isFloatingImage(ref)) warn("image-unpinned", `images: ${ref} has no tag or uses :latest; pin a version (or @sha256:) so the regression stays reproducible`);
  }
  if (env.setup) err("setup-unsupported", "environment.setup is not executed by the platform; bake the preparation into the image or do it in break.sh");

  // scripts: POSIX sh, executable-free delivery (stdin), grader prints JSON
  for (const [name, text] of Object.entries(b.scripts)) {
    if (!text) continue;
    const first = text.split("\n")[0] ?? "";
    if (!/^#!\/bin\/sh\b/.test(first)) err("script-posix-sh", `${name}.sh must start with #!/bin/sh (graders run in a minimal image via 'sh -s')`);
    if (/\r\n/.test(text)) err("script-crlf", `${name}.sh has CRLF line endings`);
  }
  if (b.scripts.check && !/"passed"/.test(b.scripts.check)) err("grader-json", "check.sh must print a JSON object with a boolean \"passed\" and \"criteria\" (ADR-0004)");
  if (b.scripts.check && !/"criteria"/.test(b.scripts.check)) err("grader-json", "check.sh must print \"criteria\"");
  if (b.scripts.solve && b.scripts.check && /solve\.sh|SOLUTION/.test(b.scripts.check)) warn("grader-independent", "check.sh seems to reference the solution; graders should check the result, not the method");
  for (const tool of b.scripts.check ? graderRcFileReaders(b.scripts.check) : []) {
    if (tool === "psql") warn("grader-psql-rc", "check.sh calls psql without -X: it reads ~/.psqlrc, which the player can write to fake the output");
    else warn("grader-curl-rc", "check.sh calls curl without -q as the first argument: it reads ~/.curlrc, which the player can write to redirect the request");
  }

  // hardening constraints
  // compared in normal form: the schema rejects "/etc/../usr", but a bundle can be built without it
  for (const raw of env.writable) {
    const w = normalMount(raw);
    if (isImmutableMount(w)) err("writable-immutable", `writable path ${raw} would make binaries/libraries mutable (R-4)`);
    if (w === "/") err("writable-root", "writable '/' defeats the read-only rootfs");
  }
  for (const rawTmpfs of Object.keys(env.tmpfs)) {
    const t = normalMount(rawTmpfs);
    if (env.writable.map(normalMount).some((w) => t === w || t.startsWith(w + "/"))) warn("tmpfs-under-writable", `tmpfs ${rawTmpfs} is under a writable volume path; the tmpfs wins (starts EMPTY, not seeded from the image)`);
    if (isImmutableMount(t)) err("tmpfs-immutable", `tmpfs on ${rawTmpfs} would hide binaries/libraries`);
  }
  for (const c of env.capabilities ?? []) {
    // Docker treats SYS_ADMIN, cap_sys_admin and CAP_SYS_ADMIN as one capability
    if (FORBIDDEN_CAPS.has(c.trim().toUpperCase().replace(/^(CAP_)+/, ""))) err("cap-forbidden", `capability ${c} is forbidden for sandboxes (ADR-0001)`);
  }
  if (env.resources.memoryMb > MEMORY_MAX_MB) err("memory-budget", `resources.memoryMb ${env.resources.memoryMb} is above ${MEMORY_MAX_MB}: the host runs many sessions at once and memory is shared between them`);
  else if (env.resources.memoryMb > MEMORY_WARN_MB) warn("memory-budget", `resources.memoryMb ${env.resources.memoryMb} is above ${MEMORY_WARN_MB}: ask for what the scenario really needs`);
  if (env.network.egress === "allowlist") warn("egress-unsupported", "network.egress=allowlist is not implemented yet; sandbox will have no egress");
  if (env.ttlMin < m.durationMin) err("ttl-too-short", `ttlMin (${env.ttlMin}) must be >= durationMin (${m.durationMin})`);
  if (env.shell.sudo && env.shell.user === "root") warn("sudo-as-root", "shell.sudo has no effect for root");

  // image: package managers must be removed (R-4). Kubernetes scenarios build app images that run INSIDE the cluster,
  // not the user's sandbox (that is the platform-wide tools image), so the rule does not apply to them.
  if (env.build && !buildEscapes && env.kind !== "kubernetes") {
    const df = path.join(b.dir, env.build, "Dockerfile");
    if (isFile(df)) {
      const text = readFileSync(df, "utf8");
      if (!/rm\s+-f[^\n]*\/usr\/bin\/(apt|dpkg|apk|pip)/.test(text) && !/rm\s+-rf[^\n]*\/var\/lib\/dpkg/.test(text)) {
        warn("image-package-managers", "Dockerfile does not remove package managers (apt/dpkg/apk/pip); rootfs is read-only anyway, but remove them (R-4)");
      }
      if (/--privileged|VOLUME\s+\/var\/run\/docker\.sock/.test(text)) err("image-forbidden", "Dockerfile references privileged mode or the docker socket");
    }
  }
  for (const s of b.scripts.break ? [b.scripts.break] : []) {
    if (PACKAGE_MANAGERS.some((p) => s.includes(p))) warn("break-package-manager", "break.sh uses a package manager; it runs after the image is built, packages must be baked into the image");
    const waits = breakWaitBudgetSec(s);
    if (waits > BREAK_BUDGET_SEC) warn("break-wait-budget", `break.sh may wait up to ~${waits} s for one thing; the grader environment gives the whole script ${BREAK_BUDGET_SEC} s, after that the session does not start`);
  }
  return out;
}
