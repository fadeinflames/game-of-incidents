// Text for the screen-reader live regions of the session page. A live region speaks when its text changes, so a
// second "не решено" with the same numbers would stay silent: the attempt number makes every verdict different.
import type { GraderResult } from "./orchestrator";

const MAX_NAMED = 3;

/** one sentence a screen reader says after a check; "" while there is no verdict yet */
export function checkAnnouncement(result: GraderResult | null, attempt: number): string {
  if (!result) return "";
  const n = attempt > 0 ? `Проверка ${attempt}. ` : "";
  if (result.status === "error") return `${n}Проверка не удалась. Попробуй ещё раз.`;
  const done = result.criteria.filter((c) => c.ok).length;
  const head = `${n}${result.passed ? "Решено" : "Не решено"}: выполнено ${done} из ${result.criteria.length}.`;
  const unmet = result.criteria.filter((c) => !c.ok);
  if (unmet.length === 0) return head;
  const named = unmet.slice(0, MAX_NAMED).map((c) => c.message.trim().replace(/[.!\s]+$/, ""));
  const more = unmet.length > MAX_NAMED ? ` и ещё ${unmet.length - MAX_NAMED}` : "";
  return `${head} Не выполнено: ${named.join("; ")}${more}.`;
}
