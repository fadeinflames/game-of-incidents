// The grader contract (ADR-0004), in one place: check.sh prints a JSON object {passed, criteria[]} and the platform reads it.
// The orchestrator (a player's "Проверить") and the CLI regression (`wom scenario test`) both parse with this, so the CLI
// can never go green on output the platform rejects.

export type GraderCriterion = { id: string; ok: boolean; message: string };
export type GraderVerdict = { passed: boolean; criteria: GraderCriterion[] };

/** "not-json": nothing in stdout parses as JSON; "incomplete": it parses, but is not a verdict the platform accepts */
export type GraderParse = { ok: true; verdict: GraderVerdict } | { ok: false; reason: "not-json" | "incomplete" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Noise around the JSON is tolerated (a service script printing to stdout): the last line that starts with `{` begins the
 * verdict. Every criterion has a string id and a boolean ok. A pass that names nothing it checked (`criteria: []`) is not a
 * pass: a forged or broken output must not turn a session green.
 */
export function parseGraderStdout(stdout: string): GraderParse {
  const text = stdout.trim();
  const start = text.lastIndexOf("\n{");
  let j: unknown;
  try {
    j = JSON.parse(start >= 0 ? text.slice(start + 1) : text);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!isObject(j) || typeof j.passed !== "boolean" || !Array.isArray(j.criteria)) return { ok: false, reason: "incomplete" };
  if (j.passed && j.criteria.length === 0) return { ok: false, reason: "incomplete" };
  const criteria: GraderCriterion[] = [];
  for (const c of j.criteria) {
    if (!isObject(c) || typeof c.id !== "string" || typeof c.ok !== "boolean") return { ok: false, reason: "incomplete" };
    criteria.push({ id: c.id, ok: c.ok, message: typeof c.message === "string" ? c.message : "" });
  }
  return { ok: true, verdict: { passed: j.passed, criteria } };
}

/** the verdict, or null when the output is not an acceptable one (the CLI does not need to tell the two reasons apart) */
export function parseGrader(stdout: string): GraderVerdict | null {
  const r = parseGraderStdout(stdout);
  return r.ok ? r.verdict : null;
}
