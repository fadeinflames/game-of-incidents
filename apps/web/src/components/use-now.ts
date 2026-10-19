"use client";

import { useEffect, useState } from "react";

/**
 * The wall clock for a countdown, ticking once a second while `active`. The first render uses the time the server
 * rendered the page at, so the markup the browser builds is the same as the server's (a `Date.now()` there would differ
 * by the latency and trip a hydration mismatch); the browser's own clock takes over right after mount.
 */
export function useNow(serverNow: number, active: boolean): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
