import { describe, expect, it } from "vitest";
import { contrastRatio, TERMINAL_BACKGROUND, TERMINAL_MIN_CONTRAST, TERMINAL_THEME } from "@/lib/terminal-theme";

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("terminal palette", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it.each(ANSI)("%s reads at 4.5:1 or better on the terminal background", (name) => {
    expect(contrastRatio(TERMINAL_THEME[name], TERMINAL_BACKGROUND)).toBeGreaterThanOrEqual(TERMINAL_MIN_CONTRAST);
  });

  it("the default text and the cursor are readable as well", () => {
    expect(contrastRatio(TERMINAL_THEME.foreground, TERMINAL_BACKGROUND)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(TERMINAL_THEME.cursor, TERMINAL_BACKGROUND)).toBeGreaterThanOrEqual(3);
  });

  it("asks xterm for the WCAG AA minimum for colours the palette does not cover", () => {
    expect(TERMINAL_MIN_CONTRAST).toBe(4.5);
  });
});
