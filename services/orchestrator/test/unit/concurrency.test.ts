import { describe, expect, it } from "vitest";
import { createLimiter, mapLimit } from "../../src/concurrency";

const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("never runs more than `limit` at once and keeps the order of the results", async () => {
    let now = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      now++;
      peak = Math.max(peak, now);
      await tick(n % 2 ? 4 : 1);
      now--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it("stops starting new items once told to, and leaves them undefined", async () => {
    let started = 0;
    const out = await mapLimit(
      [1, 2, 3, 4, 5],
      1,
      async (n) => {
        started++;
        return n;
      },
      () => started >= 2,
    );
    expect(out).toEqual([1, 2, undefined, undefined, undefined]);
  });
});

describe("createLimiter", () => {
  it("starts a call that finds room before run() returns, and queues the rest in order", async () => {
    const run = createLimiter(2);
    const started: number[] = [];
    const gates: (() => void)[] = [];
    const job = (n: number) => () => {
      started.push(n);
      return new Promise<number>((resolve) => gates.push(() => resolve(n)));
    };
    const all = [run(job(1)), run(job(2)), run(job(3)), run(job(4))];
    expect(started).toEqual([1, 2]); // synchronously
    gates[0]();
    await tick();
    expect(started).toEqual([1, 2, 3]);
    gates[1]();
    gates[2]();
    await tick();
    expect(started).toEqual([1, 2, 3, 4]);
    gates[3]();
    expect(await Promise.all(all)).toEqual([1, 2, 3, 4]);
  });

  it("a failing or throwing call frees its place", async () => {
    const run = createLimiter(1);
    const a = run(() => Promise.reject(new Error("boom")));
    const b = run(() => {
      throw new Error("sync boom");
    });
    const c = run(async () => "ok");
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("sync boom");
    await expect(c).resolves.toBe("ok");
  });
});
