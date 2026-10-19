// Colours of the terminal. xterm's default ANSI palette puts "black" and "blue" at about 1.5:1 and 3:1 on a dark
// background, so `ls --color` or a prompt in blue is hard to read. Every colour below is at least 4.5:1 on the
// background (test/terminal-theme.test.ts keeps it so), and the terminal also asks xterm for `minimumContrastRatio`,
// which lifts whatever a program draws in 256 or true colour.

export const TERMINAL_BACKGROUND = "#0b0d12";
export const TERMINAL_MIN_CONTRAST = 4.5;

export const TERMINAL_THEME = {
  background: TERMINAL_BACKGROUND,
  foreground: "#e6e8ee",
  cursor: "#f0b429",
  cursorAccent: TERMINAL_BACKGROUND,
  selectionBackground: "rgba(240, 180, 41, 0.3)",
  // "black" is drawn as a light grey: black on black is the one thing a palette cannot show
  black: "#7b8397",
  red: "#ff6b6b",
  green: "#3ecf8e",
  yellow: "#f0b429",
  blue: "#6ea8fe",
  magenta: "#d58cf5",
  cyan: "#4fd1d9",
  white: "#c9cdd8",
  brightBlack: "#8b93a7",
  brightRed: "#ff8a8a",
  brightGreen: "#6ee7b0",
  brightYellow: "#ffd166",
  brightBlue: "#93c0ff",
  brightMagenta: "#e4aefc",
  brightCyan: "#7fe3e8",
  brightWhite: "#ffffff",
} as const;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio of two #rrggbb colours, 1 to 21 */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
