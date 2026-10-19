import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";

const html = (md: string) => renderToStaticMarkup(createElement(Markdown, null, md));

describe("Markdown", () => {
  it("does not render an external image and keeps its alt text", () => {
    const out = html("![diagram](https://tracker.example/pixel.png)");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("tracker.example");
    expect(out).toContain("diagram");
  });

  it("does not render data: or relative images either", () => {
    expect(html("![a](data:image/png;base64,AAAA)")).not.toContain("<img");
    expect(html("![b](/uploads/x.png)")).not.toContain("<img");
  });

  it("drops an image without alt text", () => {
    expect(html("![](https://tracker.example/p.png)")).not.toContain("tracker.example");
  });

  it("does not turn raw html into elements", () => {
    const out = html('<img src="https://tracker.example/p.png"> <script>alert(1)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
  });

  it("still renders a table inside the scrolling wrapper", () => {
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toContain('class="table-wrap"');
  });

  // the session page owns the h1 (the scenario title); the author's headings go one level down
  it("never emits a second h1 and shifts the headings one level down", () => {
    const out = html("# Алерт\n\n## Что известно\n\n### Детали\n\nтекст");
    expect(out).not.toContain("<h1");
    expect(out).toContain('<h2 class="md-1">Алерт</h2>');
    expect(out).toContain('<h3 class="md-2">Что известно</h3>');
    expect(out).toContain("<h4>Детали</h4>");
  });

  it("marks the header cells of a table as column headers", () => {
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toContain('<th scope="col">a</th>');
  });

  it("keeps the alignment of a header cell", () => {
    expect(html("| a |\n|:-:|\n| 1 |")).toContain('scope="col" style="text-align:center"');
  });

  it("is memoized: the same text is not parsed again when the parent re-renders", () => {
    expect((Markdown as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});
