// The per-address session quota (MAX_SESSIONS_PER_IP) works on the address the web app forwards. If the proxy in front of
// the web app does not pass the real client address on, every request arrives from the proxy's own internal one: counting
// them would pool all players into one quota, so such addresses are not counted, and the quota quietly does nothing.
// This module notices that and says so (a warning in the log, a field in /health) instead of leaving it silent.
import { BlockList, isIP } from "node:net";
import { logger } from "./logger";

const internal = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  internal.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  internal.addSubnet(net, prefix, "ipv6");
}

/** loopback, private, link-local and shared (CGNAT) ranges: where a reverse proxy or the container network sits */
export function isInternalAddress(raw: string): boolean {
  // "::ffff:172.18.0.4" is an IPv4 address written the IPv6 way
  const ip = raw.trim().replace(/^::ffff:/i, "");
  const family = isIP(ip);
  if (!family) return false;
  return internal.check(ip, family === 6 ? "ipv6" : "ipv4");
}

export type IpLimitsState = "active" | "skipped-internal";

/**
 * What the address of a session request means for the quota: a public address is counted, an internal or missing one is
 * not. "skipped-internal" is reported once the recent requests (at least `minSample`) have all been like that.
 */
export class IpLimitMonitor {
  /** true = the request carried a public address; the last `window` requests */
  private recent: boolean[] = [];
  private lastWarnAt = 0;

  constructor(
    private opts: { window?: number; minSample?: number; warnEveryMs?: number; now?: () => number } = {},
  ) {}

  /** records one session request and returns the address that counts towards the quota (undefined = not counted) */
  observe(raw: string | undefined): string | undefined {
    const ip = raw && isIP(raw.trim()) ? raw.trim() : undefined;
    const counted = ip && !isInternalAddress(ip) ? ip : undefined;
    this.recent.push(counted !== undefined);
    const window = this.opts.window ?? 20;
    if (this.recent.length > window) this.recent.splice(0, this.recent.length - window);
    if (this.status() === "skipped-internal") this.warn(raw);
    return counted;
  }

  status(): IpLimitsState {
    const minSample = this.opts.minSample ?? 3;
    return this.recent.length >= minSample && !this.recent.some(Boolean) ? "skipped-internal" : "active";
  }

  private warn(raw: string | undefined) {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastWarnAt < (this.opts.warnEveryMs ?? 10 * 60_000)) return;
    this.lastWarnAt = now;
    logger.warn(
      { lastAddress: raw ? raw.slice(0, 64) : null, sample: this.recent.length },
      "per-address session limits are off: every recent request came from an internal or unknown address (does the proxy pass the real client address on?)",
    );
  }
}
