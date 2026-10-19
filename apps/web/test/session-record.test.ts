import { describe, expect, it } from "vitest";
import { failureText, FINAL_STATUSES, playerResultFromJson, playerSessionFromRow, type SessionRow } from "@/lib/session-record";

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  scenarioId: "sc1",
  status: "FINISHED",
  createdAt: new Date("2026-10-03T09:00:00.000Z"),
  readyAt: new Date("2026-10-03T09:00:20.000Z"),
  expiresAt: new Date("2026-10-03T09:45:20.000Z"),
  finishedAt: new Date("2026-10-03T09:12:00.000Z"),
  startupMs: 20_000,
  startupPhase: null,
  checkAttempts: 2,
  hintsUsed: [1],
  score: 100,
  result: { status: "ok", passed: true, criteria: [{ id: "a", ok: true, message: "Сайт отвечает 200" }] },
  lastError: null,
  ...over,
});

describe("playerSessionFromRow", () => {
  it("gives the page what the orchestrator would: status, dates as strings, score, hints, result", () => {
    const s = playerSessionFromRow(row());
    expect(s).toMatchObject({
      id: "s1",
      scenarioId: "sc1",
      status: "FINISHED",
      createdAt: "2026-10-03T09:00:00.000Z",
      readyAt: "2026-10-03T09:00:20.000Z",
      finishedAt: "2026-10-03T09:12:00.000Z",
      checkAttempts: 2,
      hintsUsed: [1],
      score: 100,
      lastError: null,
    });
    expect(s.result).toEqual({ status: "ok", passed: true, criteria: [{ id: "a", ok: true, message: "Сайт отвечает 200" }] });
  });

  it("keeps null dates null", () => {
    const s = playerSessionFromRow(row({ status: "FAILED", readyAt: null, expiresAt: null, finishedAt: null, result: null }));
    expect(s.readyAt).toBeNull();
    expect(s.expiresAt).toBeNull();
    expect(s.finishedAt).toBeNull();
    expect(s.result).toBeNull();
  });

  it("never hands the raw reason of a failed start to the player", () => {
    const s = playerSessionFromRow(row({ status: "FAILED", lastError: "docker: image wom-scenario/x:dev not found at 10.0.0.5" }));
    expect(s.lastError).not.toContain("docker");
    expect(s.lastError).not.toContain("10.0.0.5");
    expect(s.lastError).toContain("s1"); // the id to quote
  });

  it("shows no error text for a session that did not fail", () => {
    expect(playerSessionFromRow(row({ status: "KILLED", lastError: "stopped by admin" })).lastError).toBeNull();
  });

  it("the finished states are the ones that never change again", () => {
    expect([...FINAL_STATUSES].sort()).toEqual(["EXPIRED", "FAILED", "FINISHED", "KILLED"]);
  });
});

describe("playerResultFromJson", () => {
  it("drops the raw grader output", () => {
    const r = playerResultFromJson({ status: "error", error: "Проверка не ответила", detail: "bash: /opt/check.sh: line 3: secret path" });
    expect(r).toEqual({ status: "error", error: "Проверка не ответила" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("keeps only well-formed criteria and refuses anything else", () => {
    expect(playerResultFromJson({ status: "ok", passed: false, criteria: [{ id: "a", ok: false, message: "m" }, { id: 1 }, null] })).toEqual({
      status: "ok",
      passed: false,
      criteria: [{ id: "a", ok: false, message: "m" }],
    });
    for (const bad of [null, undefined, 5, "x", [], {}, { status: "ok" }, { status: "ok", passed: "yes", criteria: [] }]) {
      expect(playerResultFromJson(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("failureText", () => {
  it("knows the two reasons the orchestrator names", () => {
    expect(failureText({ id: "s1", lastError: "provisioning timed out" })).toContain("не успел подняться");
    expect(failureText({ id: "s1", lastError: "Платформа перезапускалась во время подъёма стенда. Запусти сценарий заново." })).toContain("перезапускалась");
  });
});
