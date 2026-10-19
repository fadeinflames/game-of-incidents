import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoller } from "@/lib/poller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startPoller", () => {
  it("runs once per interval", async () => {
    const run = vi.fn(async () => {});
    const p = startPoller({ run, intervalMs: () => 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(run).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it("does not start a request while the previous one is still waiting for the platform", async () => {
    let calls = 0;
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls++;
          release = resolve;
        }),
    );
    const p = startPoller({ run, intervalMs: () => 1000 });
    await vi.advanceTimersByTimeAsync(10_000); // ten intervals of a hung request
    expect(calls).toBe(1); // setInterval would have sent ten
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    p.stop();
  });

  it("asks nothing while the page is hidden, and resumes when it shows again", async () => {
    let hidden = true;
    const run = vi.fn(async () => {});
    const p = startPoller({ run, intervalMs: () => 1000, isHidden: () => hidden });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    hidden = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("poke asks at once, but not on top of a request in flight", async () => {
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const p = startPoller({ run, intervalMs: () => 60_000 });
    p.poke();
    expect(run).toHaveBeenCalledTimes(1);
    p.poke();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
  });

  it("keeps going after a failed run and reads the pace again before every wait", async () => {
    let ms = 1000;
    const run = vi.fn(async () => {
      throw new Error("offline");
    });
    const p = startPoller({ run, intervalMs: () => ms });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    ms = 5000;
    await vi.advanceTimersByTimeAsync(1000); // the second wait was already chosen at 1 s
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it("stop ends the loop", async () => {
    const run = vi.fn(async () => {});
    const p = startPoller({ run, intervalMs: () => 1000 });
    p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
