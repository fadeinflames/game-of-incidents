// Admin-side stop of training sessions through the orchestrator's internal route (the same one as the single kill).
// A few sessions at a time: destroying a kind cluster takes tens of seconds.
import "server-only";
import { ORCH_TIMEOUT, orchestrator } from "./orchestrator";

const CONCURRENCY = 3;

/** Never throws; a failure of one session does not stop the others. */
export async function stopSessions(ids: string[]): Promise<{ killed: number; failed: number }> {
  let killed = 0;
  let failed = 0;
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const r = await orchestrator(`/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE", body: {}, timeoutMs: ORCH_TIMEOUT.kill });
      if (r.status === 200) killed++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return { killed, failed };
}
