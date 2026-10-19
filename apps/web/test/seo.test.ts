import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { SITE_URL, resolveSiteUrl, siteHost } from "@/lib/site";

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../src/app", rel), "utf8");

describe("robots.txt", () => {
  const rules = robots().rules as { userAgent: string; allow: string[]; disallow: string[] };

  it("opens only the landing page: login and register carry noindex, so they are not offered to crawlers", () => {
    expect(rules.allow).toEqual(["/"]);
  });

  it("closes the catalogue, the sessions and the other signed-in pages", () => {
    for (const p of ["/scenarios", "/sessions", "/admin", "/api/"]) expect(rules.disallow).toContain(p);
  });

  it("points to the sitemap", () => {
    expect(robots().sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});

describe("sitemap.xml", () => {
  it("lists only the public pages, with absolute URLs", () => {
    expect(sitemap().map((e) => e.url)).toEqual([SITE_URL]);
  });
});

describe("site address", () => {
  it("falls back to the local development address when the environment says nothing", () => {
    expect(resolveSiteUrl({})).toBe("http://localhost:3000");
  });

  it("is built from WOM_DOMAIN", () => {
    expect(resolveSiteUrl({ WOM_DOMAIN: "play.example.org" })).toBe("https://play.example.org");
  });

  it("prefers an explicit SITE_URL over WOM_DOMAIN and drops the trailing slash", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://train.example.net/", WOM_DOMAIN: "play.example.org" })).toBe("https://train.example.net");
  });

  it("ignores blank values", () => {
    expect(resolveSiteUrl({ SITE_URL: "  ", WOM_DOMAIN: "" })).toBe("http://localhost:3000");
  });

  it("shows only the host in the link preview card", () => {
    expect(siteHost("https://play.example.org")).toBe("play.example.org");
    expect(siteHost("not a url")).toBe("not a url");
  });

  it("does not hard-code the old domain in the link preview card", () => {
    expect(read("opengraph-image.tsx")).not.toContain("game.sresh.ru");
  });
});

describe("noindex", () => {
  it.each(["(app)/layout.tsx", "(auth)/layout.tsx"])("%s marks its pages noindex", (file) => {
    expect(read(file)).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});
