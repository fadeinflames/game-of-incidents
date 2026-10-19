// The per-address quota needs real client addresses; when only the proxy's own arrives it must say so, not fail quietly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpLimitMonitor, isInternalAddress } from "../../src/ip-limits";
import { logger } from "../../src/logger";

afterEach(() => vi.restoreAllMocks());

describe("isInternalAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.18.0.4", "172.31.255.255", "192.168.1.10", "169.254.1.1", "100.64.0.9", "::1", "fd00::5", "fe80::1", "::ffff:172.18.0.4", "0.0.0.0"])("%s is internal", (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
  });

  it.each(["203.0.113.7", "8.8.8.8", "172.32.0.1", "172.15.255.255", "2001:db8::1", "::ffff:203.0.113.7", "93.184.216.34"])("%s is public", (ip) => {
    expect(isInternalAddress(ip)).toBe(false);
  });

  it("something that is not an address is not an internal one either", () => {
    expect(isInternalAddress("unknown")).toBe(false);
    expect(isInternalAddress("")).toBe(false);
  });
});

describe("IpLimitMonitor", () => {
  it("returns the address that counts towards the quota: a public one is kept, an internal or malformed one is dropped", () => {
    const m = new IpLimitMonitor();
    expect(m.observe("203.0.113.7")).toBe("203.0.113.7");
    expect(m.observe(" 203.0.113.8 ")).toBe("203.0.113.8");
    expect(m.observe("172.18.0.4")).toBeUndefined();
    expect(m.observe("unknown")).toBeUndefined();
    expect(m.observe(undefined)).toBeUndefined();
  });

  it("is active before there is enough to judge, and while real addresses arrive", () => {
    const m = new IpLimitMonitor();
    expect(m.status()).toBe("active");
    m.observe("172.18.0.4");
    m.observe("172.18.0.4");
    expect(m.status()).toBe("active"); // two requests are not a trend
    m.observe("203.0.113.7");
    m.observe("172.18.0.4");
    m.observe("172.18.0.4");
    expect(m.status()).toBe("active");
  });

  it("skipped-internal once the recent requests all came from an internal or missing address, and a warning says why", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const m = new IpLimitMonitor();
    for (const ip of ["172.18.0.4", "172.18.0.4", "unknown"]) m.observe(ip);
    expect(m.status()).toBe("skipped-internal");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain("per-address session limits are off");
  });

  it("the warning is rate limited: one per period, not one per request", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let now = 1_000_000;
    const m = new IpLimitMonitor({ warnEveryMs: 600_000, now: () => now });
    for (let i = 0; i < 10; i++) m.observe("172.18.0.4");
    expect(warn).toHaveBeenCalledTimes(1);
    now += 600_001;
    m.observe("172.18.0.4");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("goes back to active as soon as a real address shows up, and stays quiet", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const m = new IpLimitMonitor();
    for (let i = 0; i < 5; i++) m.observe("172.18.0.4");
    expect(m.status()).toBe("skipped-internal");
    m.observe("203.0.113.7");
    expect(m.status()).toBe("active");
    const before = warn.mock.calls.length;
    m.observe("203.0.113.8");
    expect(warn.mock.calls.length).toBe(before);
  });

  it("only the recent window counts: an old real address stops hiding a proxy that no longer forwards", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const m = new IpLimitMonitor({ window: 5 });
    m.observe("203.0.113.7");
    for (let i = 0; i < 5; i++) m.observe("172.18.0.4");
    expect(m.status()).toBe("skipped-internal");
  });
});
