import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diskUsedPct, egressState } from "../../src/guards";

const dir = mkdtempSync(path.join(os.tmpdir(), "wom-guards-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("egressState", () => {
  const now = () => 1_000_000 * 1000;
  const beat = (name: string, content: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  };

  it("is off when no heartbeat file is configured", async () => {
    expect(await egressState("", 150, now)).toBe("off");
  });

  it("is ok while the heartbeat is younger than the limit, the limit included", async () => {
    expect(await egressState(beat("fresh", "999990\n"), 150, now)).toBe("ok");
    expect(await egressState(beat("edge", "999850\n"), 150, now)).toBe("ok");
  });

  it("is stale when the heartbeat is older than the limit", async () => {
    expect(await egressState(beat("old", "999849\n"), 150, now)).toBe("stale");
  });

  it("is stale when the file is missing, empty or not a timestamp", async () => {
    expect(await egressState(path.join(dir, "missing"), 150, now)).toBe("stale");
    expect(await egressState(beat("empty", ""), 150, now)).toBe("stale");
    expect(await egressState(beat("junk", "iptables: no chain\n"), 150, now)).toBe("stale");
  });
});

describe("diskUsedPct", () => {
  it("reports a percentage for an existing path", async () => {
    const pct = await diskUsedPct(dir);
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThanOrEqual(0);
    expect(pct!).toBeLessThanOrEqual(100);
  });

  it("reports null when the path cannot be measured", async () => {
    expect(await diskUsedPct(path.join(dir, "no", "such", "path"))).toBeNull();
  });
});
