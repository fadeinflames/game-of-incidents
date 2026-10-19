// The player's view of a finished session built from the database row. Once a session is over nothing about it changes,
// so the page does not need the orchestrator for it: a restart or a deploy of the orchestrator must not take away the
// result and the debrief of a stand that is already gone.
import type { GraderResult, PlayerSession } from "./orchestrator";

export const FINAL_STATUSES = new Set<string>(["FINISHED", "EXPIRED", "KILLED", "FAILED"]);

/** the fields of TrainingSession the player may see (never the runtime handle, the client address or the raw error) */
export type SessionRow = {
  id: string;
  scenarioId: string;
  status: PlayerSession["status"];
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  finishedAt: Date | null;
  startupMs: number | null;
  startupPhase: string | null;
  checkAttempts: number;
  hintsUsed: number[];
  score: number | null;
  result: unknown;
  lastError: string | null;
};

// the same texts the orchestrator keeps (services/orchestrator/src/sessions.ts, failureText): the row holds the raw
// reason, which names images and versions; the player gets a sentence and the id to quote
const RESTART_MESSAGE = "Платформа перезапускалась во время подъёма стенда. Запусти сценарий заново.";
const PROVISIONING_TIMEOUT_REASON = "provisioning timed out";

export function failureText(row: Pick<SessionRow, "id" | "lastError">): string {
  if (row.lastError === RESTART_MESSAGE) return RESTART_MESSAGE;
  const ask = `Если повторится, напиши нам и назови номер сессии: ${row.id}.`;
  if (row.lastError === PROVISIONING_TIMEOUT_REASON) return `Стенд не успел подняться за отведённое время. Запусти сценарий заново. ${ask}`;
  return `Не удалось поднять стенд. Запусти сценарий заново. ${ask}`;
}

/** the grader's verdict as the player sees it: the raw output of check.sh (`detail`) stays in the database */
export function playerResultFromJson(value: unknown): GraderResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.status === "ok" && typeof v.passed === "boolean" && Array.isArray(v.criteria)) {
    const criteria = v.criteria.flatMap((c) => {
      if (typeof c !== "object" || c === null) return [];
      const { id, ok, message } = c as Record<string, unknown>;
      return typeof id === "string" && typeof ok === "boolean" && typeof message === "string" ? [{ id, ok, message }] : [];
    });
    return { status: "ok", passed: v.passed, criteria };
  }
  if (v.status === "error" && typeof v.error === "string") return { status: "error", error: v.error };
  return null;
}

export function playerSessionFromRow(row: SessionRow): PlayerSession {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    readyAt: iso(row.readyAt),
    expiresAt: iso(row.expiresAt),
    finishedAt: iso(row.finishedAt),
    startupMs: row.startupMs,
    startupPhase: row.startupPhase,
    checkAttempts: row.checkAttempts,
    hintsUsed: row.hintsUsed,
    score: row.score,
    result: playerResultFromJson(row.result),
    lastError: row.status === "FAILED" ? failureText(row) : null,
  };
}
