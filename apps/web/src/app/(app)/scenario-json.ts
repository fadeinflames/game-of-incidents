// Prisma returns the JSON columns of a scenario as `unknown`. These readers take only the fields the pages use and tolerate
// anything else (v1 hints without text, rows written before a schema change): a drifted row degrades a page, it does not break it.

export type EnvironmentView = {
  kind: "container" | "kubernetes";
  image?: string;
  ttlMin?: number;
  startup?: { expectedSec?: number; note?: string };
};

export type HintView = { level: number; penalty: number; text?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** null when the scenario has no live environment (a text-only one) */
export function parseEnvironment(json: unknown): EnvironmentView | null {
  if (!isRecord(json)) return null;
  const startup = isRecord(json.startup) ? { expectedSec: num(json.startup.expectedSec), note: str(json.startup.note) } : undefined;
  return {
    kind: json.kind === "kubernetes" ? "kubernetes" : "container",
    image: str(json.image),
    ttlMin: num(json.ttlMin),
    startup,
  };
}

/** hints sorted by level; entries without a numeric level are dropped */
export function parseHints(json: unknown): HintView[] {
  if (!Array.isArray(json)) return [];
  return json
    .flatMap((h): HintView[] => {
      if (!isRecord(h)) return [];
      const level = num(h.level);
      return level === undefined ? [] : [{ level, penalty: num(h.penalty) ?? 0, text: str(h.text) }];
    })
    .sort((a, b) => a.level - b.level);
}

/** the environment inside a submission's stored import record */
export function parseRecordEnvironment(record: unknown): EnvironmentView | null {
  return isRecord(record) ? parseEnvironment(record.environmentJson) : null;
}
