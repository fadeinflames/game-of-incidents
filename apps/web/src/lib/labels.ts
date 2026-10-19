// Status sets and their Russian labels in one place, so pages, components and API routes cannot drift apart.
// Type-only imports: client components use this module too.
import type { Difficulty, SessionStatus, SubmissionStatus } from "@wom/db";

/** must stay equal to ACTIVE_STATUSES of the orchestrator (services/orchestrator/src/sessions.ts) */
export const ACTIVE_SESSION_STATUSES = ["REQUESTED", "PROVISIONING", "READY", "RUNNING", "CHECKING"] as const satisfies readonly SessionStatus[];
export const FINAL_SESSION_STATUSES = ["FINISHED", "EXPIRED", "KILLED", "FAILED"] as const satisfies readonly SessionStatus[];

export const isFinalSessionStatus = (status: string) => (FINAL_SESSION_STATUSES as readonly string[]).includes(status);

export const SESSION_STATUS: Record<SessionStatus, string> = {
  REQUESTED: "в очереди",
  PROVISIONING: "поднимается",
  READY: "готово",
  RUNNING: "идёт",
  CHECKING: "проверяется",
  FINISHED: "решено",
  EXPIRED: "время вышло",
  KILLED: "остановлена",
  FAILED: "ошибка",
};

export const SUBMISSION_STATUS: Record<SubmissionStatus, string> = {
  UPLOADED: "ждёт проверки",
  LINT_FAILED: "ошибки формата",
  TESTING: "проверяется",
  PASSED: "проверка пройдена",
  FAILED: "проверка не пройдена",
  APPROVED: "опубликован",
  REJECTED: "отклонён",
};

export const DIFFICULTY: Record<Difficulty, string> = { JUNIOR: "Junior", MIDDLE: "Middle", SENIOR: "Senior" };

/** milliseconds as seconds with one decimal ("12.4 с"); a dash when there is no value */
export function fmtSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return `${(ms / 1000).toFixed(1)} с`;
}
