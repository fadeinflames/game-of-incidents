"use client";

import { useEffect, useRef } from "react";

/**
 * Moves the keyboard focus to the element when `when` turns true (or on mount, if it is true then): for content that
 * appears as the answer to something the person just did (an opened hint, the next stage), whose trigger button is
 * gone by then and would leave the focus on nothing. The element needs `tabIndex={-1}`.
 */
export function useFocusWhen<T extends HTMLElement>(when: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (when) ref.current?.focus();
  }, [when]);
  return ref;
}
