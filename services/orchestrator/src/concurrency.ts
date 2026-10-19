// Small helpers for bounded parallelism (no dependency).

/**
 * Runs `fn` for every item with at most `limit` calls in flight; results keep the order of `items`.
 * `shouldStop` is asked before each item is started: items not started stay `undefined` (a pass with a time budget).
 * `fn` is expected to deal with its own errors; the first one that escapes rejects the whole call.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, shouldStop?: () => boolean): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (shouldStop?.()) return;
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * A limiter for work that arrives over time: at most `max` calls run at once, the others wait in order.
 * A call that finds room starts synchronously, before `run` returns.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active--;
    while (active < max && waiting.length) {
      active++;
      waiting.shift()!();
    }
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        let p: Promise<T>;
        try {
          p = fn();
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(resolve, reject).finally(release);
      };
      if (active < max) {
        active++;
        start();
      } else waiting.push(start);
    });
}
