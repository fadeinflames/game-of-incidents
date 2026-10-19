import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenariosView, type ScenarioCard } from "@/components/scenarios-view";
import { CollapsibleDoc, StartupProgress, Timers, TtlWarning } from "@/components/session-view";
import type { PlayerSession } from "@/lib/orchestrator";

const SRC = path.resolve(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

describe("tables", () => {
  const withTable = sourceFiles(SRC).filter((f) => /<table[\s>]/.test(readFileSync(f, "utf8")));

  it("finds the pages with a table (guards the test itself)", () => {
    expect(withTable.length).toBeGreaterThanOrEqual(4);
  });

  // markdown.tsx builds its tables from the author's text and adds the scope itself
  it.each(withTable.filter((f) => !f.endsWith("markdown.tsx")).map((f) => [path.relative(SRC, f).replace(/\\/g, "/"), f]))("%s: a caption, and every header cell says what it heads", (_n, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/<caption[\s>]/);
    expect(src.match(/<th>|<th\s*\/>|<th>\s*<\/th>/g) ?? [], "a <th> without scope").toEqual([]);
    expect(src.match(/<th(?![a-z])(?![^>]*\bscope=)[^>]*>/g) ?? [], "a <th> without scope").toEqual([]);
  });
});

const card = (over: Partial<ScenarioCard>): ScenarioCard => ({
  id: "1",
  slug: "nginx-502",
  title: "Nginx отдаёт 502",
  summary: "Сайт не открывается",
  type: "linux",
  difficulty: "JUNIOR",
  durationMin: 20,
  tags: ["nginx", "nginx"],
  kind: "container",
  startupSec: null,
  progress: null,
  ...over,
});

describe("catalogue", () => {
  const html = renderToStaticMarkup(
    createElement(ScenariosView, {
      scenarios: [card({}), card({ id: "2", slug: "disk-full", title: "Диск заполнен", difficulty: "MIDDLE" })],
      capacity: null,
    }),
  );

  it("has a page heading", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it("puts the scenario cards one level under the difficulty headings", () => {
    expect(html).toMatch(/<h2[^>]*id="level-JUNIOR"/);
    expect(html).toMatch(/<h3[^>]*>[^]*?Nginx отдаёт 502/);
    expect(html).not.toMatch(/<h2[^>]*>\s*<a[^>]*href="\/scenarios\/nginx-502"/);
  });

  it("groups the filters by what they filter and names the groups", () => {
    for (const name of ["Уровень", "Тип стенда", "Формат"]) expect(html).toContain(`role="group" aria-label="${name}"`);
    expect(html).toContain('aria-pressed="false"');
  });

  it("lists the cards", () => {
    expect(html).toContain('<ul role="list"');
    expect(html.match(/<li[\s>]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("tells the identical Подробнее links apart", () => {
    expect(html).toContain("Подробнее<span class=\"sr-only\">: Nginx отдаёт 502</span>");
    expect(html).toContain("Подробнее<span class=\"sr-only\">: Диск заполнен</span>");
  });

  it("does not repeat a tag twice on a card (a repeated tag would also be a duplicate key)", () => {
    expect(html.match(/#nginx/g)).toHaveLength(2); // once on each of the two cards
  });
});

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const session = (over: Partial<PlayerSession> = {}): PlayerSession => ({
  id: "s1",
  scenarioId: "sc1",
  status: "RUNNING",
  createdAt: new Date(NOW - 5 * 60_000).toISOString(),
  readyAt: new Date(NOW - 3 * 60_000).toISOString(),
  expiresAt: new Date(NOW + 42 * 60_000).toISOString(),
  finishedAt: null,
  startupMs: 3000,
  startupPhase: null,
  checkAttempts: 0,
  hintsUsed: [],
  score: null,
  result: null,
  lastError: null,
  ...over,
});

describe("session clocks", () => {
  afterEach(() => vi.useRealTimers());

  it("draw the figures from the time the server rendered at, not from the browser's clock (no hydration mismatch)", () => {
    // the browser's clock is an hour off: markup built from it would differ from the server's
    vi.useFakeTimers({ now: NOW + 3_600_000 });
    const html = renderToStaticMarkup(createElement(Timers, { session: session(), durationMin: 20, over: false, serverNow: NOW }));
    expect(html).toContain(">03:00<"); // elapsed
    expect(html).toContain(">42:00<"); // left
    expect(html).not.toContain("63:00");
  });

  it("freeze at the end of a finished session", () => {
    const html = renderToStaticMarkup(
      createElement(Timers, { session: session({ status: "FINISHED", finishedAt: new Date(NOW - 60_000).toISOString() }), durationMin: 20, over: true, serverNow: NOW }),
    );
    expect(html).toContain(">02:00<");
    expect(html).toContain(">—<");
  });

  it("the startup wait counts from the server's time as well", () => {
    vi.useFakeTimers({ now: NOW + 3_600_000 });
    const html = renderToStaticMarkup(
      createElement(StartupProgress, { phase: "cluster", phases: ["cluster", "images", "tools", "manifests", "break"], createdAt: new Date(NOW - 90_000).toISOString(), serverNow: NOW, expectedSec: 60, note: null }),
    );
    expect(html).toContain("01:30");
  });

  it("the startup phase is announced, the ticking clock is not part of that region", () => {
    const html = renderToStaticMarkup(
      createElement(StartupProgress, { phase: "images", phases: ["cluster", "images"], createdAt: new Date(NOW).toISOString(), serverNow: NOW, expectedSec: 60, note: null }),
    );
    expect(html).toMatch(/<div role="status"><h2[^>]*>Загружаем образы в кластер…<\/h2><\/div>/);
  });
});

describe("TTL warning", () => {
  const warn = (minutes: number, running = true) =>
    renderToStaticMarkup(createElement(TtlWarning, { running, expiresAt: new Date(NOW + minutes * 60_000).toISOString(), serverNow: NOW }));

  it("keeps its live region in the page when there is nothing to say, so the warning is spoken when it comes", () => {
    const html = warn(30);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("ttl-warning");
  });

  it("speaks in the last five minutes and in the last minute", () => {
    expect(warn(4)).toMatch(/role="status"[^>]*>.*data-testid="ttl-warning".*Меньше 5 минут/);
    expect(warn(0.5)).toMatch(/role="status"[^>]*>.*Меньше минуты/);
  });

  it("says nothing about a stand that is not running", () => {
    expect(warn(1, false)).not.toContain("ttl-warning");
  });
});

describe("documents", () => {
  it("two sections with the same title render without a duplicate-key warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(
        createElement(CollapsibleDoc, {
          doc: {
            preamble: "",
            sections: [
              { title: "Что известно", md: "один" },
              { title: "Что известно", md: "два" },
            ],
          },
        }),
      );
      expect(html).toContain("один");
      expect(html).toContain("два");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("motion", () => {
  it("the stylesheet turns animations and transitions off for people who asked for less motion", () => {
    const css = readFileSync(path.join(SRC, "app/globals.css"), "utf8");
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toContain("scroll-behavior: auto !important");
  });

  it("links in running text are underlined, buttons that are links are not", () => {
    const css = readFileSync(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).toMatch(/\ba \{[^}]*text-decoration: underline/);
    expect(css).toMatch(/\.btn \{[^}]*text-decoration: none/);
  });

  it("the sticky action bar sits under the app header", () => {
    const view = readFileSync(path.join(SRC, "components/session-view.tsx"), "utf8");
    expect(view).toContain("max-lg:top-[var(--nav-h)]");
  });
});
