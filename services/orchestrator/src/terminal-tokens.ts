// One-time terminal tokens (ADR-0002): issued by the platform after an ownership check, consumed once, short TTL.
import { randomBytes } from "node:crypto";

type Entry = { sessionId: string; userId: string; expiresAt: number };

/** unused tokens one session may hold at a time: the browser needs one per connection attempt, not a stockpile */
export const MAX_TOKENS_PER_SESSION = 5;

export class TerminalTokenStore {
  private tokens = new Map<string, Entry>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  issue(sessionId: string, userId: string): string {
    this.prune();
    this.dropOldest(sessionId);
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, { sessionId, userId, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** returns the entry and deletes it; null if unknown, expired or for a different session */
  consume(token: string, sessionId: string): Entry | null {
    const e = this.tokens.get(token);
    this.tokens.delete(token);
    if (!e || e.expiresAt < this.now() || e.sessionId !== sessionId) return null;
    return e;
  }

  /** the Map keeps insertion order, so the first match is the oldest */
  private dropOldest(sessionId: string) {
    let held = 0;
    let oldest: string | undefined;
    for (const [k, e] of this.tokens) {
      if (e.sessionId !== sessionId) continue;
      held++;
      oldest ??= k;
    }
    if (held >= MAX_TOKENS_PER_SESSION && oldest) this.tokens.delete(oldest);
  }

  private prune() {
    const t = this.now();
    for (const [k, e] of this.tokens) if (e.expiresAt < t) this.tokens.delete(k);
  }

  get size() {
    return this.tokens.size;
  }
}
