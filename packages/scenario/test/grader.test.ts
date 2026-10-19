// The one reading of check.sh's output: the orchestrator (via parseGraderStdout) and the CLI regression (via parseGrader).
import { describe, expect, it } from "vitest";
import { parseGrader, parseGraderStdout } from "../src";

const ok = '{"passed": true, "criteria": [{"id": "a", "ok": true, "message": "fine"}]}';

describe("parseGraderStdout", () => {
  it("returns the verdict with every criterion filled in", () => {
    expect(parseGraderStdout('{"passed": false, "criteria": [{"id": "a", "ok": false}]}')).toEqual({
      ok: true,
      verdict: { passed: false, criteria: [{ id: "a", ok: false, message: "" }] },
    });
  });

  it("reads the last line that opens an object, past noise before it", () => {
    expect(parseGraderStdout(`rolling out...\n{"note": 1}\n${ok}\n`)).toMatchObject({ ok: true, verdict: { passed: true } });
  });

  it("tells output that is not JSON from JSON that is not a verdict", () => {
    expect(parseGraderStdout("")).toEqual({ ok: false, reason: "not-json" });
    expect(parseGraderStdout("all good")).toEqual({ ok: false, reason: "not-json" });
    expect(parseGraderStdout(`${ok} trailing`)).toEqual({ ok: false, reason: "not-json" });
    expect(parseGraderStdout('{"passed": true}')).toEqual({ ok: false, reason: "incomplete" });
    expect(parseGraderStdout('{"passed": "yes", "criteria": []}')).toEqual({ ok: false, reason: "incomplete" });
    expect(parseGraderStdout("[1]")).toEqual({ ok: false, reason: "incomplete" });
  });

  it("does not accept a pass that names nothing it checked", () => {
    expect(parseGraderStdout('{"passed": true, "criteria": []}')).toEqual({ ok: false, reason: "incomplete" });
  });

  it("accepts a failure with no criteria: it can only turn a session red", () => {
    expect(parseGraderStdout('{"passed": false, "criteria": []}')).toEqual({ ok: true, verdict: { passed: false, criteria: [] } });
  });

  it("rejects a criterion without a string id or a boolean ok", () => {
    for (const c of ['{"ok": true}', '{"id": 1, "ok": true}', '{"id": "a", "ok": "true"}', '"a"', "null"]) {
      expect(parseGraderStdout(`{"passed": false, "criteria": [${c}]}`), c).toEqual({ ok: false, reason: "incomplete" });
    }
  });
});

describe("parseGrader", () => {
  it("is the same reading, as a verdict or null", () => {
    expect(parseGrader(ok)).toEqual({ passed: true, criteria: [{ id: "a", ok: true, message: "fine" }] });
    for (const bad of ["", "nope", '{"passed": true, "criteria": []}', '{"passed": true}']) expect(parseGrader(bad), bad).toBeNull();
  });
});
