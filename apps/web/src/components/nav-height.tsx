"use client";

import { useEffect } from "react";

/**
 * Publishes the real height of the sticky app header as --nav-h (globals.css): on a phone the header wraps to two rows,
 * and whatever sticks below it, or scrolls to an anchor or a focused field, has to clear it. Renders nothing.
 */
export function NavHeight() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("[data-app-nav]");
    if (!header) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--nav-h", `${header.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--nav-h");
    };
  }, []);
  return null;
}
