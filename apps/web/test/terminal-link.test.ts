import { describe, expect, it } from "vitest";
import {
  closeReason,
  DOUBLE_ESC_MS,
  isDoubleEscape,
  MAX_RECONNECTS,
  nextAttempt,
  pingUnanswered,
  reconnectDelayMs,
  shouldReconnect,
  STABLE_AFTER_MS,
  statusText,
  tokenRefusalIsFinal,
} from "@/lib/terminal-link";

describe("shouldReconnect", () => {
  it("retries the closes a deploy, a network drop or a restart produce", () => {
    for (const code of [1001, 1005, 1006, 1011, 1012, 1013]) expect(shouldReconnect(code), String(code)).toBe(true);
  });

  it("does not retry a shell that exited, or a window that was replaced by another one", () => {
    expect(shouldReconnect(1000)).toBe(false);
    expect(shouldReconnect(4000)).toBe(false);
  });

  it("does not retry a policy or protocol violation", () => {
    for (const code of [1002, 1003, 1008, 1009]) expect(shouldReconnect(code), String(code)).toBe(false);
  });
});

describe("reconnectDelayMs", () => {
  it("doubles from a second and stops growing at 15 s", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => reconnectDelayMs(n))).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it("spreads a crowd of browsers with the jitter, never more than a quarter on top", () => {
    expect(reconnectDelayMs(2, 0.5)).toBe(2250);
    expect(reconnectDelayMs(2, 5)).toBeLessThanOrEqual(2500);
    expect(reconnectDelayMs(2, -1)).toBe(2000);
  });
});

describe("nextAttempt", () => {
  it("counts up while the link keeps dying young", () => {
    expect(nextAttempt(0, 0)).toBe(1);
    expect(nextAttempt(3, 2000)).toBe(4);
  });

  it("starts over after a link that stayed up long enough", () => {
    expect(nextAttempt(5, STABLE_AFTER_MS)).toBe(1);
  });

  it("a server that accepts and drops at once cannot keep the terminal retrying for ever", () => {
    let n = 0;
    let tries = 0;
    while ((n = nextAttempt(n, 100)) <= MAX_RECONNECTS) tries++;
    expect(tries).toBe(MAX_RECONNECTS);
  });
});

describe("pingUnanswered", () => {
  it("is false before the first ping", () => {
    expect(pingUnanswered(null, 0)).toBe(false);
  });

  it("is true when nothing has arrived since the ping was sent", () => {
    expect(pingUnanswered(1000, 900)).toBe(true);
  });

  it("is false when a pong or any output came after the ping", () => {
    expect(pingUnanswered(1000, 1001)).toBe(false);
    expect(pingUnanswered(1000, 1000)).toBe(false);
  });
});

describe("isDoubleEscape", () => {
  it("needs a first press", () => {
    expect(isDoubleEscape(null, 1000)).toBe(false);
  });

  it("accepts the second press inside the window, not after it", () => {
    expect(isDoubleEscape(1000, 1000 + DOUBLE_ESC_MS)).toBe(true);
    expect(isDoubleEscape(1000, 1000 + DOUBLE_ESC_MS + 1)).toBe(false);
  });
});

describe("texts", () => {
  it("names the attempt of a reconnect and never counts past the limit", () => {
    expect(statusText("reconnecting", 2)).toContain(`2 из ${MAX_RECONNECTS}`);
    expect(statusText("reconnecting", 99)).toContain(`${MAX_RECONNECTS} из ${MAX_RECONNECTS}`);
  });

  it("keeps the words the e2e test and the player know", () => {
    expect(statusText("connected")).toBe("подключён");
    expect(statusText("connecting")).toBe("подключаемся…");
    expect(statusText("disconnected")).toBe("отключён");
    expect(statusText("error")).toBe("ошибка");
  });

  it("says why the link is down", () => {
    expect(closeReason(4000)).toContain("другом окне");
    expect(closeReason(1000)).toContain("завершилась");
    expect(closeReason(1006)).toContain("прервалась");
  });

  it("a refused token is final for a session that is gone, not for a busy platform", () => {
    for (const s of [401, 403, 404, 409]) expect(tokenRefusalIsFinal(s), String(s)).toBe(true);
    for (const s of [429, 500, 502, 503]) expect(tokenRefusalIsFinal(s), String(s)).toBe(false);
  });
});
