// A polling loop that cannot pile up. setInterval fires on schedule whether or not the previous request came back, so a
// slow platform gets a queue of requests, and a background tab keeps asking. This waits for each run to finish, then
// waits the interval, and skips the run while the page is hidden; `poke` runs it at once (the tab came back).

export type PollerOptions = {
  run: () => Promise<void>;
  /** read before every wait, so the pace can follow the state */
  intervalMs: () => number;
  /** true while nobody looks at the page */
  isHidden?: () => boolean;
};

export type Poller = { stop: () => void; poke: () => void };

export function startPoller({ run, intervalMs, isHidden = () => false }: PollerOptions): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs());
  };

  async function tick() {
    timer = null;
    if (stopped) return;
    if (isHidden()) return schedule();
    running = true;
    try {
      await run();
    } catch {
      // a failed poll is the caller's business (it shows "offline"); the loop goes on
    } finally {
      running = false;
    }
    schedule();
  }

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    poke() {
      if (stopped || running) return;
      if (timer) clearTimeout(timer);
      void tick();
    },
  };
}
