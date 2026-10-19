// Folder -> ScenarioBundle -> ImportRecord. The folder is the authoring format; JSON is only transport (ADR-0005).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_NODE_IMAGE, scenarioV1Schema, scenarioV2Schema, type ImportRecord, type ScenarioV2 } from "./schema";

export type ScenarioBundle = {
  dir: string;
  meta: ScenarioV2;
  briefMd: string | null;
  debriefMd: string | null;
  guideMd: string | null;
  scripts: { setup: string | null; break: string | null; check: string | null; solve: string | null };
};

export class ScenarioLoadError extends Error {
  constructor(
    message: string,
    public issues: string[] = [],
  ) {
    super(message);
    this.name = "ScenarioLoadError";
  }
}

/** what is at the path: a path through a file ("a.txt/b") or a missing one is "none", never an exception */
export function pathKind(p: string): "file" | "dir" | "other" | "none" {
  try {
    const st = statSync(p);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch {
    return "none";
  }
}
export const isFile = (p: string) => pathKind(p) === "file";
export const isDirectory = (p: string) => pathKind(p) === "dir";

function readIf(dir: string, rel?: string): string | null {
  if (!rel) return null;
  const p = path.resolve(dir, rel);
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new ScenarioLoadError(`file reference escapes the scenario folder: ${rel}`);
  const kind = pathKind(p);
  // an archive can put a folder where scenario.yaml names a file: that is the author's mistake, not a crash with EISDIR
  if (kind === "dir" || kind === "other") throw new ScenarioLoadError(`${rel} must be a file, but it is a folder`);
  return kind === "file" ? readFileSync(p, "utf8") : null;
}

export function loadScenarioFolder(dir: string): ScenarioBundle {
  const yamlPath = path.join(dir, "scenario.yaml");
  if (pathKind(yamlPath) === "dir") throw new ScenarioLoadError("scenario.yaml must be a file, but it is a folder");
  if (!isFile(yamlPath)) throw new ScenarioLoadError(`no scenario.yaml in ${dir}`);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(yamlPath, "utf8"));
  } catch (e) {
    throw new ScenarioLoadError(`scenario.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = scenarioV2Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioLoadError(
      "scenario.yaml does not match schema v2",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const meta = parsed.data;
  const env = meta.environment;
  return {
    dir,
    meta,
    briefMd: readIf(dir, meta.brief),
    debriefMd: readIf(dir, meta.debrief),
    guideMd: readIf(dir, meta.guide),
    scripts: {
      setup: readIf(dir, env?.setup),
      break: readIf(dir, env?.break),
      check: readIf(dir, env?.check),
      solve: readIf(dir, env?.solve),
    },
  };
}

export type PublicEnvironment = Omit<NonNullable<ScenarioV2["environment"]>, "build" | "setup" | "break" | "check" | "solve" | "manifests"> & {
  manifests?: { name: string; content: string }[];
};

/** environment for the DB/UI: no file references, no scripts; kubernetes manifests inlined (they are not secret) */
export function publicEnvironment(env: NonNullable<ScenarioV2["environment"]>, dir?: string): PublicEnvironment {
  const { build: _b, setup: _s, break: _br, check: _c, solve: _so, manifests, ...rest } = env;
  const out: PublicEnvironment = { ...rest };
  if (env.kind === "kubernetes" && manifests && dir) out.manifests = readManifests(dir, manifests);
  return out;
}

/** names of the *.yaml files directly in a folder, sorted (a folder that is named like a manifest does not count) */
export function manifestFileNames(mdir: string): string[] {
  if (!isDirectory(mdir)) return [];
  return readdirSync(mdir)
    .filter((f) => /\.ya?ml$/.test(f) && isFile(path.join(mdir, f)))
    .sort();
}

export function readManifests(dir: string, rel: string): { name: string; content: string }[] {
  const mdir = path.resolve(dir, rel);
  if (!mdir.startsWith(path.resolve(dir) + path.sep)) throw new ScenarioLoadError(`manifests dir escapes the scenario folder: ${rel}`);
  if (pathKind(mdir) === "file") throw new ScenarioLoadError(`${rel} must be a folder with *.yaml, but it is a file`);
  return manifestFileNames(mdir).map((f) => ({ name: f, content: readFileSync(path.join(mdir, f), "utf8") }));
}

/**
 * Public images a scenario makes the host pull (so they can be pulled ahead of the first session): the images kind loads into
 * the nodes, and the kindest/node image of a cluster. The scenario's own wom-scenario/* images and the platform's wom-* ones are built locally.
 */
export function prepullImages(env: ScenarioV2["environment"] | null | undefined): string[] {
  if (!env) return [];
  const out = new Set(env.images.filter((img) => !img.startsWith("wom-scenario/") && !img.startsWith("wom-")));
  if (env.kind === "kubernetes") out.add(env.cluster?.nodeImage ?? DEFAULT_NODE_IMAGE);
  return [...out].sort();
}

/** the card of a scenario shows these four from contextJson; the column is free-form JSON, so anything else is dropped, not cast */
export type ScenarioContext = { infra?: string; setup?: string; time?: string; services?: string[] };

export function parseScenarioContext(json: unknown): ScenarioContext {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const o = json as Record<string, unknown>;
  const out: ScenarioContext = {};
  for (const k of ["infra", "setup", "time"] as const) if (typeof o[k] === "string" && o[k]) out[k] = o[k];
  if (Array.isArray(o.services)) out.services = o.services.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out;
}

export function toImportRecord(b: ScenarioBundle): ImportRecord {
  const m = b.meta;
  return {
    slug: m.slug,
    schemaVersion: 2,
    title: m.title,
    summary: m.summary,
    type: m.type,
    difficulty: m.difficulty,
    durationMin: m.durationMin,
    tags: m.tags,
    contextJson: m.contextJson,
    eventsJson: m.eventsJson,
    hintsJson: m.hintsJson,
    actionsJson: m.actionsJson,
    gmScriptJson: m.gmScriptJson,
    briefMd: b.briefMd,
    debriefMd: b.debriefMd,
    guideMd: b.guideMd,
    environmentJson: m.environment ? publicEnvironment(m.environment, b.dir) : null,
    breakScript: b.scripts.break,
    graderScript: b.scripts.check,
    solutionScript: b.scripts.solve,
  };
}

/** v1 (wom-games) -> ImportRecord: text-only, slug derived from the title */
export function v1ToImportRecord(raw: unknown): ImportRecord {
  const s = scenarioV1Schema.parse(raw);
  return {
    slug: slugify(s.title),
    schemaVersion: 1,
    title: s.title,
    summary: s.summary,
    type: s.type,
    difficulty: s.difficulty,
    durationMin: s.durationMin,
    tags: [],
    contextJson: s.contextJson,
    eventsJson: s.eventsJson,
    hintsJson: s.hintsJson,
    actionsJson: s.actionsJson,
    gmScriptJson: s.gmScriptJson ?? null,
    briefMd: null,
    debriefMd: null,
    guideMd: null,
    environmentJson: null,
    breakScript: null,
    graderScript: null,
    solutionScript: null,
  };
}

/**
 * A v1 file derives the slug from the title and upserts by it, so a title that slugs to a live scenario would silently replace
 * it (environment, scripts, author) with a text-only record. Only a row that is itself a v1 import may be re-imported.
 */
export function v1Overwrites(records: ImportRecord[], existing: { slug: string; schemaVersion: number }[]): string[] {
  const live = new Map(existing.map((e) => [e.slug, e.schemaVersion]));
  return records.filter((r) => r.schemaVersion === 1 && live.has(r.slug) && live.get(r.slug) !== 1).map((r) => r.slug);
}

const translit: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .split("")
    .map((ch) => translit[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s.length >= 3 ? s : `scenario-${s}x`.slice(0, 64);
}

export type GuideStep = { title: string; md: string };

/** guide.md -> stages: every `## Heading` starts a stage; text before the first heading is dropped */
export function splitGuide(md: string | null | undefined): GuideStep[] {
  if (!md) return [];
  const steps: GuideStep[] = [];
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) steps.push({ title: h[1], md: "" });
    else if (steps.length) steps[steps.length - 1].md += line + "\n";
  }
  return steps.map((s) => ({ ...s, md: s.md.trim() })).filter((s) => s.md.length > 0);
}

export const TUTORIAL_SUFFIX = "-tutorial";
/**
 * Reference material of a teaching brief: dropped from the regular copy, and in the teaching copy the session page shows it
 * beside the terminal instead of inside the brief (owner feedback 2026-09-30)
 */
export const REFERENCE_SECTIONS = ["Шпаргалка", "Почитать заранее"];

/** splits `## ` sections whose heading is in `names` out of a markdown document */
export function extractSections(md: string, names: string[]): { rest: string; extracted: string } {
  const rest: string[] = [];
  const extracted: string[] = [];
  let target = rest;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) target = names.includes(h[1].trim()) ? extracted : rest;
    target.push(line);
  }
  const tidy = (a: string[]) => a.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { rest: tidy(rest), extracted: tidy(extracted) };
}

/** the regular copy's brief: no "🎓" callout paragraphs, no cheat sheet / pre-reading sections */
export function stripTutorialParts(md: string): string {
  const out: string[] = [];
  let skipSection = false;
  let skipQuote = false;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) skipSection = REFERENCE_SECTIONS.includes(h[1].trim());
    if (skipSection) continue;
    if (/^>\s*🎓/.test(line)) skipQuote = true;
    if (skipQuote) {
      if (line.trim() === "") skipQuote = false;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Owner decision (2026-09-30): every teaching case ships as two catalog entries — a tutorial copy (stages, free hints 1-2)
 * and a regular copy for people who know their way around. One folder with guide.md produces both.
 */
export function importVariants(r: ImportRecord): { regular: ImportRecord; tutorial: ImportRecord | null } {
  if (!r.guideMd) return { regular: { ...r, tags: r.tags.filter((t) => t !== "tutorial") }, tutorial: null };
  const regular: ImportRecord = {
    ...r,
    guideMd: null,
    briefMd: r.briefMd ? stripTutorialParts(r.briefMd) : r.briefMd,
    tags: r.tags.filter((t) => t !== "tutorial"),
  };
  const tutorial: ImportRecord = {
    ...r,
    slug: r.slug + TUTORIAL_SUFFIX,
    title: r.title + " · учебный",
    tags: [...r.tags.filter((t) => t !== "tutorial"), "tutorial"],
    hintsJson: r.hintsJson.map((h) => (typeof h.level === "number" && h.level <= 2 ? { ...h, penalty: 0 } : h)),
  };
  return { regular, tutorial };
}

export type MarkdownSection = { title: string; md: string };
export type SplitMarkdown = { preamble: string; sections: MarkdownSection[] };

/** a brief/debrief as the session page renders it: the preamble stays as is, every `## ` section becomes a collapsible block */
export function splitSections(md: string | null | undefined): SplitMarkdown {
  if (!md) return { preamble: "", sections: [] };
  const pre: string[] = [];
  const sections: MarkdownSection[] = [];
  let cur: string[] | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = [];
      sections.push({ title: h[1].trim(), md: "" });
      continue;
    }
    (cur ?? pre).push(line);
    if (cur) sections[sections.length - 1].md += line + "\n";
  }
  return { preamble: pre.join("\n").trim(), sections: sections.map((x) => ({ ...x, md: x.md.trim() })) };
}
