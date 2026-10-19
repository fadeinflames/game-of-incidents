import { describe, expect, it } from "vitest";
import { clientIpFromRequest, publicClientIp, rateLimit } from "@/lib/rate-limit";

const withHeaders = (headers: Record<string, string>) => new Request("http://web.test/", { headers });

describe("client address", () => {
  it("takes the last X-Forwarded-For element, the one the proxy wrote", () => {
    expect(clientIpFromRequest(withHeaders({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores headers the client controls", () => {
    expect(clientIpFromRequest(withHeaders({ "cf-connecting-ip": "6.6.6.6", "x-real-ip": "6.6.6.6" }))).toBeNull();
  });

  it("does not identify anybody by an internal address", () => {
    expect(publicClientIp(withHeaders({ "x-forwarded-for": "172.18.0.1" }))).toBeNull();
    expect(publicClientIp(withHeaders({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });
});

describe("rateLimit", () => {
  it("lets `limit` calls through and then reports the wait", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, { limit: 3, windowMs: 60_000 }).ok).toBe(true);
    const blocked = rateLimit(key, { limit: 3, windowMs: 60_000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });
});
