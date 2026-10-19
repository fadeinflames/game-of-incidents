import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ScenarioLoadError, TUTORIAL_SUFFIX, extractSections, importVariants, loadScenarioFolder, slugify, splitGuide, splitSections, stripTutorialParts, toImportRecord } from "../src/load";
import type { ImportRecord } from "../src/schema";
import { parseGrader } from "../src/grader";
import { cleanupFixtures, scenarioDir } from "./fixture";

afterAll(cleanupFixtures);

const BRIEF = `# ALERT

> 🎓 **Учебный кейс.** Под брифом есть панель помощи,
> она открывает этапы по одному.

## Что известно

- Раскатка зависла.

> Обычная цитата остаётся.

## Шпаргалка

| Команда | Что показывает |
|---|---|
| kubectl get pods | состояние подов |

## Цель

Починить.

## Почитать заранее

- [Probes](https://kubernetes.io/docs/)
`;

const record = (over: Partial<ImportRecord> = {}): ImportRecord => ({
  slug: "demo-case",
  schemaVersion: 2,
  title: "Demo",
  summary: "The service answers 502.",
  type: "linux",
  difficulty: "JUNIOR",
  durationMin: 20,
  tags: ["linux"],
  contextJson: {},
  eventsJson: [],
  hintsJson: [
    { level: 1, penalty: 3, text: "one" },
    { level: 2, penalty: 5, text: "two" },
    { level: 3, penalty: 15, text: "three" },
  ],
  actionsJson: [],
  gmScriptJson: null,
  briefMd: BRIEF,
  debriefMd: "## Что было сломано\n",
  guideMd: null,
  environmentJson: null,
  breakScript: null,
  graderScript: null,
  solutionScript: null,
  ...over,
});

describe("splitGuide", () => {
  it("turns every '## ' heading into a stage and drops the text before the first one", () => {
    expect(splitGuide("# Title\n\nintro\n\n## One\n\nfirst\nlines\n\n## Two  \r\n\r\nsecond\r\n")).toEqual([
      { title: "One", md: "first\nlines" },
      { title: "Two", md: "second" },
    ]);
  });

  it("drops stages without a body and ignores deeper headings", () => {
    expect(splitGuide("## Empty\n\n## Full\n\n### Detail\n\ntext\n")).toEqual([{ title: "Full", md: "### Detail\n\ntext" }]);
  });

  it("returns no stages for empty input or text without headings", () => {
    expect(splitGuide(null)).toEqual([]);
    expect(splitGuide("")).toEqual([]);
    expect(splitGuide("just text\n#not a heading\n")).toEqual([]);
  });
});

describe("stripTutorialParts", () => {
  const stripped = stripTutorialParts(BRIEF);

  it("removes the 🎓 callout up to the blank line, including its continuation lines", () => {
    expect(stripped).not.toContain("🎓");
    expect(stripped).not.toContain("она открывает этапы");
    expect(stripped).toContain("> Обычная цитата остаётся.");
  });

  it("removes the cheat sheet and the pre-reading section but keeps the sections between them", () => {
    expect(stripped).not.toContain("Шпаргалка");
    expect(stripped).not.toContain("kubectl get pods");
    expect(stripped).not.toContain("Почитать заранее");
    expect(stripped).not.toContain("kubernetes.io");
    expect(stripped).toContain("## Что известно\n\n- Раскатка зависла.");
    expect(stripped).toContain("## Цель\n\nПочинить.");
  });

  it("leaves no runs of blank lines and ends with one newline", () => {
    expect(stripped).not.toMatch(/\n{3,}/);
    expect(stripped.endsWith("Починить.\n")).toBe(true);
  });

  it("does not touch a brief without tutorial parts", () => {
    expect(stripTutorialParts("# A\n\n## Цель\n\nПочинить.\n")).toBe("# A\n\n## Цель\n\nПочинить.\n");
  });
});

describe("importVariants", () => {
  it("produces only the regular copy when there is no guide, without the tutorial tag", () => {
    const { regular, tutorial } = importVariants(record({ tags: ["linux", "tutorial"] }));
    expect(tutorial).toBeNull();
    expect(regular.tags).toEqual(["linux"]);
    expect(regular.briefMd).toBe(BRIEF);
  });

  it("splits a scenario with a guide into a regular and a tutorial copy", () => {
    const source = record({ guideMd: "## Этап\n\nкоманда\n", tags: ["linux", "tutorial"] });
    const { regular, tutorial } = importVariants(source);

    expect(regular.slug).toBe("demo-case");
    expect(regular.guideMd).toBeNull();
    expect(regular.tags).toEqual(["linux"]);
    expect(regular.briefMd).toBe(stripTutorialParts(BRIEF));
    expect(regular.hintsJson).toEqual(source.hintsJson);

    expect(tutorial).not.toBeNull();
    expect(tutorial!.slug).toBe("demo-case" + TUTORIAL_SUFFIX);
    expect(tutorial!.title).toBe("Demo · учебный");
    expect(tutorial!.tags).toEqual(["linux", "tutorial"]);
    expect(tutorial!.guideMd).toBe(source.guideMd);
    expect(tutorial!.briefMd).toBe(BRIEF);
    expect(tutorial!.hintsJson.map((h) => h.penalty)).toEqual([0, 0, 15]);
    // both copies share the secret scripts and the environment
    expect(tutorial!.graderScript).toBe(regular.graderScript);
    expect(tutorial!.environmentJson).toBe(regular.environmentJson);
  });

  it("works on the broken-probes sample end to end", () => {
    const dir = path.join(fileURLToPath(new URL("../../../scenarios", import.meta.url)), "broken-probes");
    const { regular, tutorial } = importVariants(toImportRecord(loadScenarioFolder(dir)));
    expect(regular.slug).toBe("broken-probes");
    expect(regular.briefMd).not.toMatch(/🎓|## Шпаргалка|## Почитать заранее/);
    expect(tutorial?.slug).toBe("broken-probes-tutorial");
    expect(tutorial?.briefMd).toMatch(/🎓/);
    expect(splitGuide(tutorial?.guideMd).length).toBeGreaterThan(1);
  });
});

describe("markdown sections", () => {
  it("extractSections moves the named sections out and keeps the rest in order", () => {
    const { rest, extracted } = extractSections(BRIEF, ["Шпаргалка", "Почитать заранее"]);
    expect(extracted.startsWith("## Шпаргалка")).toBe(true);
    expect(extracted).toContain("## Почитать заранее");
    expect(rest).toContain("## Цель");
    expect(rest).not.toContain("Шпаргалка");
  });

  it("splitSections keeps the preamble and makes a block of every '## ' section", () => {
    const { preamble, sections } = splitSections("# T\n\nintro\n\n## A\n\none\n\n## B\n\ntwo\n");
    expect(preamble).toBe("# T\n\nintro");
    expect(sections).toEqual([
      { title: "A", md: "one" },
      { title: "B", md: "two" },
    ]);
    expect(splitSections(null)).toEqual({ preamble: "", sections: [] });
  });
});

describe("slugify", () => {
  it.each([
    ["Nginx 502: upstream down", "nginx-502-upstream-down"],
    ["Сломанные пробы", "slomannye-proby"],
    ["  --Щи--  ", "schi"],
    ["!!", "scenario-x"],
  ])("%s -> %s", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it("never exceeds 64 characters", () => {
    expect(slugify("a".repeat(200)).length).toBe(64);
  });
});

describe("loadScenarioFolder", () => {
  it("loads the fixture with its scripts and texts", () => {
    const b = loadScenarioFolder(scenarioDir());
    expect(b.meta.slug).toBe("demo-case");
    expect(b.briefMd).toContain("## Цель");
    expect(b.scripts.check).toContain('"passed"');
    expect(b.guideMd).toBeNull();
  });

  it.each([
    ["brief", { meta: { brief: "../outside.md" } }],
    ["check script", { env: { check: "../../etc/passwd" } }],
  ])("refuses a %s reference that leaves the scenario folder", (_label, opts) => {
    expect(() => loadScenarioFolder(scenarioDir(opts))).toThrowError(/escapes the scenario folder/);
  });

  it("reports schema violations with their paths", () => {
    const dir = scenarioDir({ meta: { slug: "Bad Slug", durationMin: 1 } });
    try {
      loadScenarioFolder(dir);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioLoadError);
      expect((e as ScenarioLoadError).issues.map((i) => i.split(":")[0])).toEqual(expect.arrayContaining(["slug", "durationMin"]));
    }
  });

  it("refuses a folder without scenario.yaml and broken YAML", () => {
    expect(() => loadScenarioFolder(scenarioDir({ files: { "scenario.yaml": null } }))).toThrowError(/no scenario\.yaml/);
    expect(() => loadScenarioFolder(scenarioDir({ files: { "scenario.yaml": "a: [1, 2\n" } }))).toThrowError(/not valid YAML/);
  });
});

describe("parseGrader", () => {
  const verdict = '{"passed": false, "criteria": [{"id": "http", "ok": false, "message": "502"}]}';

  it("reads a bare JSON verdict", () => {
    expect(parseGrader(verdict + "\n")).toEqual({ passed: false, criteria: [{ id: "http", ok: false, message: "502" }] });
  });

  it("takes the last JSON line of a noisy stdout", () => {
    expect(parseGrader(`waiting for rollout...\n{"note": "not the verdict"}\ndeployment "web" successfully rolled out\n${verdict}\n`)?.passed).toBe(false);
  });

  it.each([
    ["no output", ""],
    ["not JSON", "all good\n"],
    ["JSON without criteria", '{"passed": true}\n'],
    ["passed is not a boolean", '{"passed": "yes", "criteria": []}\n'],
    ["text after the verdict", `${verdict}\ndone\n`],
  ])("returns null for %s", (_label, stdout) => {
    expect(parseGrader(stdout)).toBeNull();
  });
});
