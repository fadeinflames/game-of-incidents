// Host preconditions for new sessions: room on the disk and an egress guard that is alive.
import { readFile, statfs } from "node:fs/promises";

export type EgressState = "ok" | "stale" | "off";

/** used space the way df reports it (blocks reserved for root do not count as free), percent; null = cannot be measured */
export async function diskUsedPct(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    const used = s.blocks - s.bfree;
    const total = used + s.bavail;
    return total > 0 ? Math.ceil((used * 100) / total) : null;
  } catch {
    return null;
  }
}

/**
 * The egress guard rewrites the heartbeat file with `date +%s` after every successful rule check (R-7).
 * A file that is missing, unreadable or older than maxAgeSec means the rules may be gone: "stale".
 */
export async function egressState(file: string, maxAgeSec: number, now: () => number = Date.now): Promise<EgressState> {
  if (!file) return "off";
  let beat = await readBeat(file);
  if (beat === null) {
    // the guard truncates the file before writing: an empty read may be that instant, look once more
    await new Promise((r) => setTimeout(r, 100));
    beat = await readBeat(file);
  }
  if (beat === null) return "stale";
  return now() / 1000 - beat <= maxAgeSec ? "ok" : "stale";
}

async function readBeat(file: string): Promise<number | null> {
  try {
    const beat = Number((await readFile(file, "utf8")).trim());
    return Number.isFinite(beat) && beat > 0 ? beat : null;
  } catch {
    return null;
  }
}
