// Status chip. The status -> tone maps live here so a "rejected" and a "published" chip never look the same.
export type Tone = "neutral" | "ok" | "warn" | "bad";

/** TrainingSession.status: in progress = warn, solved = ok, lost = bad */
export const SESSION_TONE: Record<string, Tone> = {
  REQUESTED: "warn",
  PROVISIONING: "warn",
  READY: "neutral",
  RUNNING: "neutral",
  CHECKING: "warn",
  FINISHED: "ok",
  EXPIRED: "bad",
  KILLED: "neutral",
  FAILED: "bad",
};

/** ScenarioSubmission.status */
export const SUBMISSION_TONE: Record<string, Tone> = {
  UPLOADED: "neutral",
  LINT_FAILED: "bad",
  TESTING: "warn",
  PASSED: "ok",
  FAILED: "bad",
  APPROVED: "ok",
  REJECTED: "bad",
};

/** `live`: a text that changes while the page is open (a session status) is announced by screen readers */
export function Badge({ tone = "neutral", testId, title, live, children }: { tone?: Tone; testId?: string; title?: string; live?: boolean; children: React.ReactNode }) {
  return (
    <span className={tone === "neutral" ? "badge" : `badge badge-${tone}`} data-testid={testId} title={title} role={live ? "status" : undefined}>
      {children}
    </span>
  );
}
