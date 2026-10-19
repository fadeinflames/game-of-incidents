// Structured trail on stdout (docker logs / Loki): who did what to what, never passwords or tokens.
import "server-only";
import { createHash } from "node:crypto";

export type AdminAction = {
  /** id of the admin who acted */
  actor: string;
  /** e.g. disable, enable, make-admin, make-user, reset-password, kill, kill-all, publish, unpublish, test, approve, reject */
  action: string;
  /** what was acted on, as "kind:id" (user:<id>, session:<id>, scenario:<id>, submission:<id>, sessions:all) */
  target: string;
};

/** One JSON line per state-changing admin action. Only the four fixed fields are written, so a request body can never leak into the log. */
export function auditAdmin(entry: AdminAction): void {
  console.log(JSON.stringify({ event: "admin_action", actor: entry.actor, action: entry.action, target: entry.target, at: new Date().toISOString() }));
}

/** Short stable digest of a typed login: the trail shows repeated guesses of one name without storing what a user may have typed into the wrong field (a password). */
export function hashIdentity(identity: string): string {
  return createHash("sha256").update(identity.trim().toLowerCase()).digest("hex").slice(0, 16);
}
