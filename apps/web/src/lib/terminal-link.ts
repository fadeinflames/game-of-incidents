// Decisions of the terminal's WebSocket link, kept apart from the component so they can be tested without a browser:
// when to give up on a silent socket, whether a close is worth a retry, how long to wait, how many attempts to make.

/** the browser pings every 20 s; the orchestrator answers a ping with a pong frame and also pings by itself every 30 s */
export const PING_INTERVAL_MS = 20_000;
/** automatic attempts in a row before the terminal asks the person to press the button */
export const MAX_RECONNECTS = 6;
/** a link that stayed up this long was healthy: its next drop starts the attempt counter from scratch */
export const STABLE_AFTER_MS = 15_000;
/** two Escape presses this close together leave the terminal */
export const DOUBLE_ESC_MS = 600;

/** WebSocket close code the orchestrator uses when a newer window took over the session's terminal */
export const CLOSE_REPLACED = 4000;
const CLOSE_NORMAL = 1000;
/** a normal close means the shell exited; a policy or protocol violation will not heal by trying again */
const NO_RETRY = new Set<number>([CLOSE_NORMAL, CLOSE_REPLACED, 1002, 1003, 1007, 1008, 1009]);

/**
 * Is a closed socket worth an automatic retry? A deploy, a network drop or a restart of the orchestrator (1001, 1006,
 * 1011, 1012...) are; a shell that exited, or another window that took the terminal over, are not: retrying the second
 * would start a fight between two windows.
 */
export function shouldReconnect(code: number): boolean {
  return !NO_RETRY.has(code);
}

/** exponential backoff, 1 s, 2 s, 4 s ... capped at 15 s; `attempt` counts from 1; `jitter` in [0, 1) spreads a crowd after a restart */
export function reconnectDelayMs(attempt: number, jitter = 0): number {
  const base = Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 + 0.25 * Math.min(Math.max(jitter, 0), 0.999)));
}

/** the attempt counter after a drop: reset when the link had been up long enough, otherwise one more */
export function nextAttempt(previous: number, livedMs: number): number {
  return livedMs >= STABLE_AFTER_MS ? 1 : previous + 1;
}

/**
 * The link is dead when the previous ping went unanswered for a whole interval: no frame of any kind (a pong, output)
 * has arrived since it was sent, even though the browser has not noticed (a sleeping laptop, a dropped NAT entry).
 * Measured against the ping rather than the clock, so a background tab whose timers are throttled to once a minute is not
 * mistaken for a dead link.
 */
export function pingUnanswered(pingSentAt: number | null, lastFrameAt: number): boolean {
  return pingSentAt !== null && lastFrameAt < pingSentAt;
}

/** the second Escape of a double press (the first one still reaches the shell: vim and readline use it) */
export function isDoubleEscape(previousAt: number | null, now: number, windowMs = DOUBLE_ESC_MS): boolean {
  return previousAt !== null && now - previousAt <= windowMs;
}

export type LinkStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

/** the status line next to the terminal's title */
export function statusText(status: LinkStatus, attempt = 0, max = MAX_RECONNECTS): string {
  switch (status) {
    case "connected":
      return "подключён";
    case "connecting":
      return "подключаемся…";
    case "reconnecting":
      return `связь потеряна, переподключаемся (${Math.min(attempt, max)} из ${max})…`;
    case "error":
      return "ошибка";
    default:
      return "отключён";
  }
}

/** why the link is down, for the line written into the terminal itself and for a screen reader */
export function closeReason(code: number): string {
  if (code === CLOSE_REPLACED) return "терминал открыт в другом окне";
  if (code === CLOSE_NORMAL) return "оболочка завершилась";
  return "связь с терминалом прервалась";
}

/** HTTP statuses of the token request that will not change by asking again (not signed in, no such or no longer running session) */
export function tokenRefusalIsFinal(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 409;
}
