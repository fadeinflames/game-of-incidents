// The orchestrator -> web contract (ADR-0003): what the player's session looks like on the wire and how a check ends.
// Types only, no runtime code, so a client component can `import type` them. The orchestrator builds these values, the
// web app reads them; both import from here instead of keeping a copy each.
import type { GraderCriterion } from "@wom/scenario";
import type { SessionStatus } from "@prisma/client";

export type Criterion = GraderCriterion;

/** check.sh's verdict as the orchestrator stores and returns it (ADR-0004); `detail` never reaches a player */
export type GraderResult =
  | { status: "ok"; passed: boolean; criteria: Criterion[] }
  | { status: "error"; error: string; detail?: string };

/** T is Date inside the orchestrator and string on the wire (JSON) */
export type PlayerSessionOf<T> = {
  id: string;
  scenarioId: string;
  status: SessionStatus;
  createdAt: T;
  readyAt: T | null;
  expiresAt: T | null;
  finishedAt: T | null;
  startupMs: number | null;
  startupPhase: string | null;
  checkAttempts: number;
  hintsUsed: number[];
  score: number | null;
  result: GraderResult | null;
  lastError: string | null;
  /** only while the session waits for a cluster slot (REQUESTED): the place in the queue, 1 = next */
  queuePosition?: number;
  /** a rough wait for that place, minutes; null = could not be estimated */
  queueEtaMin?: number | null;
};

/** a session as the web app receives it */
export type PlayerSession = PlayerSessionOf<string>;
