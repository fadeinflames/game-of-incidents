import { describe, expect, it } from "vitest";
import { MAX_TOKENS_PER_SESSION, TerminalTokenStore } from "../../src/terminal-tokens";

describe("TerminalTokenStore", () => {
  it("issues a token that can be consumed exactly once for its session", () => {
    const store = new TerminalTokenStore(1000);
    const t = store.issue("s1", "u1");
    expect(store.consume(t, "s1")).toEqual({ sessionId: "s1", userId: "u1", expiresAt: expect.any(Number) });
    expect(store.consume(t, "s1")).toBeNull();
  });

  it("rejects a token used for another session", () => {
    const store = new TerminalTokenStore(1000);
    const t = store.issue("s1", "u1");
    expect(store.consume(t, "s2")).toBeNull();
  });

  it("rejects unknown and expired tokens", () => {
    let now = 0;
    const store = new TerminalTokenStore(100, () => now);
    const t = store.issue("s1", "u1");
    now = 101;
    expect(store.consume(t, "s1")).toBeNull();
    expect(store.consume("nope", "s1")).toBeNull();
  });

  it("keeps a bounded number of unused tokens per session, dropping the oldest, and leaves other sessions alone", () => {
    const store = new TerminalTokenStore(60_000);
    const other = store.issue("s2", "u2");
    const tokens = Array.from({ length: MAX_TOKENS_PER_SESSION + 2 }, () => store.issue("s1", "u1"));
    expect(store.size).toBe(MAX_TOKENS_PER_SESSION + 1);
    expect(store.consume(tokens[0], "s1")).toBeNull();
    expect(store.consume(tokens[1], "s1")).toBeNull();
    expect(store.consume(tokens[2], "s1")).not.toBeNull();
    expect(store.consume(tokens[tokens.length - 1], "s1")).not.toBeNull();
    expect(store.consume(other, "s2")).not.toBeNull();
  });
});
