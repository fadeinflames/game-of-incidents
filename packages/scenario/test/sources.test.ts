// `sources`: the public postmortems a scenario retells. The links are shown to players under the debrief, so the schema
// holds them to plain https, and what is read back from the database is filtered again (rows are not re-validated on read).
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_SOURCES, SOURCE_URL_RE, importRecordSchema, parseSources, scenarioV2Schema, sourceSchema } from "../src/schema";
import { ScenarioLoadError, importVariants, loadScenarioFolder, toImportRecord, v1ToImportRecord } from "../src/load";
import { cleanupFixtures, scenarioDir } from "./fixture";

afterAll(cleanupFixtures);

const SRC = { title: "Cloudflare, 18.11.2025: outage post-mortem", url: "https://blog.cloudflare.com/18-november-2025-outage/" };

describe("sources in scenario.yaml", () => {
  it("is optional and defaults to an empty list", () => {
    const b = loadScenarioFolder(scenarioDir());
    expect(b.meta.sources).toEqual([]);
    expect(toImportRecord(b).sourcesJson).toEqual([]);
  });

  it("travels from the folder into the import record, and into both copies of a teaching scenario", () => {
    const b = loadScenarioFolder(scenarioDir({ meta: { sources: [SRC] } }));
    const record = toImportRecord(b);
    expect(record.sourcesJson).toEqual([SRC]);
    const { regular, tutorial } = importVariants({ ...record, guideMd: "## Этап\n\nкоманда\n" });
    expect(regular.sourcesJson).toEqual([SRC]);
    expect(tutorial?.sourcesJson).toEqual([SRC]);
  });

  it.each([
    ["http", "http://example.com/post"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<b>x</b>"],
    ["credentials", "https://user:secret@example.com/"],
    ["space", "https://example.com/a b"],
    ["quote", 'https://example.com/"x'],
    ["angle bracket", "https://example.com/<script>"],
    ["no host", "https://"],
  ])("refuses a %s link", (_label, url) => {
    expect(sourceSchema.safeParse({ title: "A post", url }).success).toBe(false);
    expect(() => loadScenarioFolder(scenarioDir({ meta: { sources: [{ title: "A post", url }] } }))).toThrow(ScenarioLoadError);
  });

  it.each([
    "https://blog.cloudflare.com/18-november-2025-outage/",
    "https://web.archive.org/web/20160720200842/https://stackstatus.net/post/147710624694/outage-postmortem-july-20-2016",
    "https://github.com/dfds/postmortems/blob/master/PM2022-008%20-%20CRUD.md",
    "https://habr.com/ru/post/499542",
    "https://example.com:8443/a?b=c&d=e#f",
    "https://example.com",
  ])("accepts %s", (url) => {
    expect(sourceSchema.safeParse({ title: "A post", url }).success).toBe(true);
  });

  it("refuses unknown keys, a short title and more than the limit", () => {
    expect(sourceSchema.safeParse({ ...SRC, note: "x" }).success).toBe(false);
    expect(sourceSchema.safeParse({ title: "ab", url: SRC.url }).success).toBe(false);
    const many = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => ({ title: `Post ${i}`, url: `https://example.com/${i}` }));
    expect(scenarioV2Schema.shape.sources.safeParse(many).success).toBe(false);
    expect(scenarioV2Schema.shape.sources.safeParse(many.slice(0, MAX_SOURCES)).success).toBe(true);
  });
});

describe("sourcesJson in an import record", () => {
  it("is optional: a file exported before the field existed still validates and gets an empty list", () => {
    const parsed = importRecordSchema.shape.sourcesJson.safeParse(undefined);
    expect(parsed.success && parsed.data).toEqual([]);
  });

  it("is empty for a v1 (text-only) scenario", () => {
    const r = v1ToImportRecord({ title: "Old text case", summary: "A text-only scenario from wom-games.", type: "kubernetes" });
    expect(r.sourcesJson).toEqual([]);
  });

  it("is held to the same rules as the scenario file", () => {
    expect(importRecordSchema.shape.sourcesJson.safeParse([SRC]).success).toBe(true);
    expect(importRecordSchema.shape.sourcesJson.safeParse([{ title: "A post", url: "javascript:alert(1)" }]).success).toBe(false);
  });
});

describe("parseSources (reading a stored row)", () => {
  it("returns valid entries and drops everything else", () => {
    expect(parseSources([SRC, { title: "bad", url: "javascript:alert(1)" }, null, "x", { url: SRC.url }])).toEqual([SRC]);
  });

  it.each([null, undefined, "x", 1, {}, { 0: SRC }])("returns [] for %j", (v) => {
    expect(parseSources(v)).toEqual([]);
  });

  it("never returns more than the limit", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Post ${i}`, url: `https://example.com/${i}` }));
    expect(parseSources(many)).toHaveLength(MAX_SOURCES);
  });
});

describe("schemas/wom.scenario.v2.json", () => {
  const mirror = JSON.parse(readFileSync(new URL("../../../schemas/wom.scenario.v2.json", import.meta.url), "utf8"));
  const prop = mirror.properties.scenarios.items.properties.sourcesJson;

  it("uses the same link pattern and limits as the schema", () => {
    expect(new RegExp(prop.items.properties.url.pattern).source).toBe(SOURCE_URL_RE.source);
    expect(prop.maxItems).toBe(MAX_SOURCES);
    expect(prop.items.additionalProperties).toBe(false);
    expect([...prop.items.required].sort()).toEqual(["title", "url"]);
  });
});
