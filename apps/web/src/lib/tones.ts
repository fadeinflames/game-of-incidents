// CSS colour variables that carry meaning (see :root in app/globals.css): difficulty is a traffic light, the stand type has its own pair.
export const DIFFICULTY_TONE = { JUNIOR: "var(--junior)", MIDDLE: "var(--middle)", SENIOR: "var(--senior)" } as const;
export const KIND_TONE = { container: "var(--linux)", kubernetes: "var(--k8s)" } as const;
export const TUTORIAL_TONE = "var(--ok)";

/** inline style for the .tile / .pill / .icon-chip classes, which read --tone */
export const tone = (color: string) => ({ "--tone": color }) as React.CSSProperties;
