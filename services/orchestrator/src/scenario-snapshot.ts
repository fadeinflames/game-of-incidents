// A session runs on the scenario as it was when the player pressed "start". Scenario rows are rewritten in place by every
// import (seed, /api/import, a moderator's approval), so without a copy a deploy that ships a new check.sh would grade
// a running session by the new script against a stand broken by the old one, and shift its hints and their penalties.
import type { Prisma, Scenario } from "@wom/db";
import { parseEnvironment, type Environment } from "@wom/runtime";

export type PinnedHint = { level: number; text: string; penalty: number };

/** what is stored in TrainingSession.scenarioSnapshot; `v` leaves room to change the shape */
export type ScenarioSnapshot = {
  v: 1;
  environment: unknown;
  hints: PinnedHint[];
  breakScript: string | null;
  graderScript: string | null;
};

/** the scenario as a session uses it, from the snapshot when there is one */
export type PinnedScenario = {
  /** as stored; pinnedEnvironment() checks its shape (only the calls that start or attach to a stand need it) */
  environmentJson: unknown;
  hints: PinnedHint[];
  breakScript: string | null;
  graderScript: string | null;
  /** false = no snapshot (a row from before the column, or one already cleared): this is the live scenario */
  pinned: boolean;
};

type ScenarioSource = Pick<Scenario, "environmentJson" | "hintsJson" | "breakScript" | "graderScript">;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** hintsJson is free-form JSON from an import: whatever is not a hint with a level and a text is not one */
export function readHints(json: unknown): PinnedHint[] {
  if (!Array.isArray(json)) return [];
  const out: PinnedHint[] = [];
  for (const h of json) {
    if (!isObject(h) || typeof h.level !== "number" || typeof h.text !== "string") continue;
    out.push({ level: h.level, text: h.text, penalty: typeof h.penalty === "number" ? h.penalty : 0 });
  }
  return out;
}

export function snapshotScenario(s: ScenarioSource): Prisma.InputJsonValue {
  const snapshot: ScenarioSnapshot = {
    v: 1,
    environment: s.environmentJson ?? null,
    hints: readHints(s.hintsJson),
    breakScript: s.breakScript,
    graderScript: s.graderScript,
  };
  return snapshot as unknown as Prisma.InputJsonValue;
}

function readSnapshot(json: unknown): ScenarioSnapshot | null {
  if (!isObject(json) || json.v !== 1 || !Array.isArray(json.hints)) return null;
  const script = (v: unknown) => (typeof v === "string" ? v : null);
  return { v: 1, environment: json.environment ?? null, hints: readHints(json.hints), breakScript: script(json.breakScript), graderScript: script(json.graderScript) };
}

/** The snapshot of the session when it has one, the live scenario otherwise (null = there is neither). */
export function pinnedScenario(session: { scenarioSnapshot?: unknown }, live: ScenarioSource | null): PinnedScenario {
  const snap = readSnapshot(session.scenarioSnapshot);
  if (snap) return { environmentJson: snap.environment, hints: snap.hints, breakScript: snap.breakScript, graderScript: snap.graderScript, pinned: true };
  if (!live) return { environmentJson: null, hints: [], breakScript: null, graderScript: null, pinned: false };
  return { environmentJson: live.environmentJson, hints: readHints(live.hintsJson), breakScript: live.breakScript, graderScript: live.graderScript, pinned: false };
}

/** the stand the scenario describes, null for a text-only scenario; throws when the stored value is not an environment */
export function pinnedEnvironment(p: Pick<PinnedScenario, "environmentJson">): Environment | null {
  return p.environmentJson == null ? null : parseEnvironment(p.environmentJson);
}
