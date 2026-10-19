import { describe, expect, it } from "vitest";
import { computeScore, GRADER_ERRORS, parseGraderOutput, playerResult } from "../../src/grader";

describe("parseGraderOutput", () => {
  it("parses a valid result", () => {
    const r = parseGraderOutput('{"passed":true,"criteria":[{"id":"a","ok":true,"message":"m"}]}\n', 0, "", false);
    expect(r).toEqual({ status: "ok", passed: true, criteria: [{ id: "a", ok: true, message: "m" }] });
  });

  it("takes the last JSON line when a service script printed noise first", () => {
    const out = 'Reloading nginx configuration: nginx.\n{"passed":false,"criteria":[]}\n';
    expect(parseGraderOutput(out, 0, "", false)).toEqual({ status: "ok", passed: false, criteria: [] });
  });

  it("reports invalid JSON as an error, never as passed", () => {
    const r = parseGraderOutput("garbage", 0, "", false);
    expect(r.status).toBe("error");
  });

  it("reports a non-zero exit as an error", () => {
    const r = parseGraderOutput("", 2, "boom", false);
    expect(r).toMatchObject({ status: "error", error: "проверка завершилась с ошибкой (код 2)", detail: "boom" });
  });

  it("reports timeouts", () => {
    expect(parseGraderOutput("", -1, "", true)).toEqual({ status: "error", error: GRADER_ERRORS.timedOut });
  });

  it("does not accept a pass that lists no criteria", () => {
    expect(parseGraderOutput('{"passed":true,"criteria":[]}', 0, "", false)).toEqual({ status: "error", error: GRADER_ERRORS.incomplete });
  });

  it("does not read a verdict out of a flooded output", () => {
    const tail = '{"passed":true,"criteria":[{"id":"a","ok":true,"message":"m"}]}\n';
    expect(parseGraderOutput(tail, 0, "", false, true)).toEqual({ status: "error", error: GRADER_ERRORS.outputTooLarge });
  });

  it("still takes only a JSON object that starts its own line", () => {
    const sameLine = 'noise {"passed":true,"criteria":[{"id":"a","ok":true,"message":"m"}]}';
    expect(parseGraderOutput(sameLine, 0, "", false).status).toBe("error");
    const trailing = '{"passed":true,"criteria":[{"id":"a","ok":true,"message":"m"}]}\nmore';
    expect(parseGraderOutput(trailing, 0, "", false).status).toBe("error");
  });

  it("rejects criteria without id/ok", () => {
    expect(parseGraderOutput('{"passed":true,"criteria":[{"ok":true}]}', 0, "", false).status).toBe("error");
  });
});

describe("playerResult", () => {
  it("drops the raw stderr of check.sh and keeps the rest", () => {
    expect(playerResult({ status: "error", error: "x", detail: "secret path /etc/foo" })).toEqual({ status: "error", error: "x" });
  });

  it("leaves a normal result and null alone", () => {
    const ok = { status: "ok", passed: false, criteria: [{ id: "a", ok: false, message: "m" }] };
    expect(playerResult(ok)).toBe(ok);
    expect(playerResult(null)).toBeNull();
  });
});

describe("computeScore", () => {
  it("subtracts hint penalties from 100 and floors at 0", () => {
    expect(computeScore([])).toBe(100);
    expect(computeScore([0, 5, 15])).toBe(80);
    expect(computeScore([60, 60])).toBe(0);
  });
});
