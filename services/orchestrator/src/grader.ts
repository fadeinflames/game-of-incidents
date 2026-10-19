import type { Criterion, GraderResult } from "@wom/db";
import { parseGraderStdout } from "@wom/scenario";

// Grader result contract (ADR-0004). check.sh prints exactly one JSON object to stdout; the types are shared with the web app (@wom/db).
export type { Criterion, GraderResult };

// `error` is shown to the player after "Проверка не удалась: ", so it is a Russian fragment without a final period;
// `detail` (raw stderr of check.sh) stays in the database and the admin pages, playerResult() strips it from API answers.
export const GRADER_ERRORS = {
  timedOut: "проверка не уложилась в отведённое время",
  badOutput: "проверка вернула непонятный ответ",
  incomplete: "проверка вернула неполный ответ",
  noGrader: "у сценария нет проверки",
  couldNotRun: "не удалось запустить проверку",
  outputTooLarge: "вывод проверки слишком большой",
} as const;

export function parseGraderOutput(stdout: string, exitCode: number, stderr: string, timedOut: boolean, outputTooLarge = false): GraderResult {
  if (timedOut) return { status: "error", error: GRADER_ERRORS.timedOut };
  // what is left of a flooded output is a tail the player could have written: it is never read as a verdict
  if (outputTooLarge) return { status: "error", error: GRADER_ERRORS.outputTooLarge };
  // the same reader as the CLI regression (`wom scenario test`): noise around the JSON is tolerated, an empty pass is not
  const parsed = parseGraderStdout(stdout);
  if (!parsed.ok) {
    if (parsed.reason === "incomplete") return { status: "error", error: GRADER_ERRORS.incomplete };
    return {
      status: "error",
      error: exitCode !== 0 ? `проверка завершилась с ошибкой (код ${exitCode})` : GRADER_ERRORS.badOutput,
      detail: (stderr || stdout).slice(0, 2000),
    };
  }
  return { status: "ok", passed: parsed.verdict.passed, criteria: parsed.verdict.criteria };
}

/** what the API gives the player: the raw stderr of check.sh hints at the scenario's mechanics and at the host */
export function playerResult(result: unknown): unknown {
  if (!isObject(result) || !("detail" in result)) return result;
  const { detail: _detail, ...rest } = result;
  return rest;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** score = 100 minus hint penalties, floored at 0 (ADR-0005: penalties in points) */
export function computeScore(hintPenalties: number[]): number {
  return Math.max(0, 100 - hintPenalties.reduce((a, b) => a + b, 0));
}
