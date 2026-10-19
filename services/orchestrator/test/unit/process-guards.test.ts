import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFatalHandlers } from "../../src/process-guards";

function setup(cleanup?: () => Promise<void> | void, graceMs = 3000) {
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const log = vi.fn();
  installFatalHandlers({ proc, log, cleanup, graceMs });
  return { proc, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("installFatalHandlers", () => {
  it("logs an uncaught exception as one structured line and leaves with code 1 once the cleanup is done", async () => {
    const cleanup = vi.fn(async () => {});
    const { proc, log } = setup(cleanup);
    proc.emit("uncaughtException", new Error("boom"));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ kind: "uncaughtException", err: expect.objectContaining({ message: "boom" }) }), expect.stringContaining("fatal"));
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("treats an unhandled rejection the same way, whatever was rejected", async () => {
    const { proc, log } = setup();
    proc.emit("unhandledRejection", "just a string");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ kind: "unhandledRejection", err: expect.objectContaining({ message: "just a string" }) }), expect.any(String));
    await vi.advanceTimersByTimeAsync(0);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it("does not wait for a cleanup that hangs longer than the grace period", async () => {
    const { proc } = setup(() => new Promise<void>(() => {}), 3000);
    proc.emit("uncaughtException", new Error("boom"));
    await vi.advanceTimersByTimeAsync(2999);
    expect(proc.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("a cleanup that throws still ends in the exit, and a second error while leaving is logged but does not restart it", async () => {
    const cleanup = vi.fn(() => {
      throw new Error("server.close failed");
    });
    const { proc, log } = setup(cleanup);
    proc.emit("uncaughtException", new Error("first"));
    proc.emit("unhandledRejection", new Error("second"));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][1]).toContain("another fatal error");
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it("listens for both events", () => {
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    installFatalHandlers({ proc, log: vi.fn() });
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
  });
});
