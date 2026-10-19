import { afterAll, describe, expect, it } from "vitest";
import { breakWaitBudgetSec, isFloatingImage, lintBundle, registryOf } from "../src/lint";
import { loadScenarioFolder, ScenarioLoadError } from "../src/load";
import { cleanupFixtures, scenarioDir, type FixtureOptions } from "./fixture";

afterAll(cleanupFixtures);

const lint = (opts: FixtureOptions = {}) => lintBundle(loadScenarioFolder(scenarioDir(opts)));
const rules = (opts: FixtureOptions = {}, level?: "error" | "warning") =>
  lint(opts)
    .filter((i) => !level || i.level === level)
    .map((i) => i.rule);
const k8s = (images: string[], env: Record<string, unknown> = {}): FixtureOptions => ({
  kind: "kubernetes",
  env: { images: ["wom-scenario/demo-case:dev", ...images], ...env },
  files: {
    "k8s/extra.yaml":
      images.map((i) => `kind: Pod\nspec:\n  containers:\n    - name: c\n      image: ${i}\n      resources:\n        requests: { cpu: 10m, memory: 16Mi }\n        limits: { memory: 64Mi }\n`).join("---\n") || "kind: Namespace\n",
  },
});

describe("paths that leave the scenario folder", () => {
  it.each([
    ["build up and out", { build: "../elsewhere" }],
    ["build far up", { build: "../../.." }],
    ["absolute build", { build: "/opt" }],
    ["build with a drive letter", { build: "C:\\work" }],
    ["build with backslashes", { build: "image\\..\\..\\x" }],
    ["build with .. in the middle", { build: "image/../../x" }],
    ["manifests up and out", { kind: "kubernetes", manifests: "../k8s" }],
    ["absolute manifests", { kind: "kubernetes", manifests: "/etc" }],
  ])("the loader refuses %s", (_label, env) => {
    const dir = scenarioDir({ env, files: { "image/Dockerfile": "FROM alpine:3.20\n" } });
    try {
      loadScenarioFolder(dir);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioLoadError);
      expect((e as ScenarioLoadError).issues.join("\n")).toMatch(/environment\.(build|manifests): must stay inside the scenario folder/);
    }
  });

  it("accepts a build folder that merely starts with dots", () => {
    expect(rules({ env: { build: "./image/..hidden" }, files: { "image/..hidden/Dockerfile": "FROM alpine:3.20\nRUN rm -f /sbin/apk\n" } }, "error")).toEqual([]);
  });

  it("the linter still stops a bundle that was assembled without the schema", () => {
    const b = loadScenarioFolder(scenarioDir());
    b.meta.environment!.build = "../..";
    expect(lintBundle(b).map((i) => i.rule)).toContain("build-escapes");
  });
});

describe("mount paths in normal form", () => {
  it.each([
    ["writable", { writable: ["/etc/../usr/bin"] }],
    ["writable with a dot segment", { writable: ["/usr/./local"] }],
    ["writable with a doubled slash", { writable: ["/usr//bin"] }],
    ["writable with a trailing slash", { writable: ["/home/"] }],
    ["tmpfs", { tmpfs: { "/var/../usr/share": "size=64m" } }],
    ["tmpfs with a trailing slash", { tmpfs: { "/run/": "size=64m" } }],
  ])("the loader refuses %s", (_label, env) => {
    expect(() => loadScenarioFolder(scenarioDir({ env }))).toThrowError(ScenarioLoadError);
  });

  it("the linter compares the normalised path when the schema was bypassed", () => {
    const b = loadScenarioFolder(scenarioDir());
    b.meta.environment!.writable = ["/etc/../usr/bin", "/home/oncall/../../bin/"];
    b.meta.environment!.tmpfs = { "/var/../lib/x": "size=8m" };
    const found = lintBundle(b).filter((i) => i.level === "error");
    expect(found.map((i) => i.rule)).toEqual(["writable-immutable", "writable-immutable", "tmpfs-immutable"]);
  });

  it("accepts the default mounts and the root of the writable-root rule", () => {
    expect(rules({ env: { writable: ["/etc", "/var", "/home", "/root", "/opt/app"] } }, "error")).toEqual([]);
    expect(rules({ env: { writable: ["/"] } }, "error")).toContain("writable-root");
  });
});

describe("image sources", () => {
  it("a container scenario without build runs its own image or a listed base", () => {
    expect(rules({ env: { build: undefined } }, "error")).toEqual([]);
    expect(rules({ env: { build: undefined, image: "debian:bookworm-slim" } }, "error")).toEqual([]);
  });

  it.each([
    ["someone else's scenario image", "wom-scenario/another:dev"],
    ["a platform image", "wom-tools:dev"],
    ["whatever the daemon happens to hold", "postgres:16"],
    ["a private registry", "registry.example.com/tools/x:1"],
  ])("a container scenario without build may not start %s", (_label, image) => {
    expect(rules({ env: { build: undefined, image } }, "error")).toContain("image-source");
  });

  it("a kubernetes scenario gets the platform tools image only", () => {
    expect(rules(k8s([], { image: "debian:bookworm-slim" }), "error")).toContain("image-source");
    expect(rules(k8s([], { image: "wom-tools:dev" }), "error")).toEqual([]);
  });

  it("images may not pull in another scenario's image", () => {
    expect(rules(k8s([], { images: ["wom-scenario/demo-case:dev", "wom-scenario/another:dev"] }), "error")).toContain("image-source");
  });

  it.each([
    ["another scenario behind the Docker Hub host", "docker.io/wom-scenario/another:dev"],
    ["a platform image", "wom-tools:dev"],
    ["a platform image behind the Docker Hub host", "docker.io/library/wom-egress-guard:dev"],
    ["a platform image behind library/", "library/wom-sysv-shims:dev"],
  ])("images refuse %s", (_label, ref) => {
    expect(rules(k8s([ref]), "error")).toContain("image-source");
  });

  it.each([
    ["Docker Hub", "postgres:16-alpine"],
    ["a Docker Hub namespace", "prom/prometheus:v2.55.1"],
    ["registry.k8s.io", "registry.k8s.io/ingress-nginx/controller:v1.12.1"],
    ["quay.io", "quay.io/jetstack/cert-manager-controller:v1.17.2"],
    ["ghcr.io", "ghcr.io/letsencrypt/pebble:2.10.1"],
    ["a digest", `nginx@sha256:${"ab".repeat(32)}`],
  ])("images accept %s", (_label, ref) => {
    expect(rules(k8s([ref]))).toEqual([]);
  });

  it.each([
    ["an unknown registry", "evil.example.com/library/postgres:16"],
    ["a registry with a port", "registry.local:5000/postgres:16"],
    ["localhost", "localhost/postgres:16"],
  ])("images refuse %s", (_label, ref) => {
    expect(rules(k8s([ref]), "error")).toContain("image-registry");
  });

  it.each([
    ["no tag", "nginx"],
    [":latest", "postgres:latest"],
    ["no tag in a registry", "quay.io/jetstack/cert-manager-controller"],
  ])("images warn about %s", (_label, ref) => {
    expect(rules(k8s([ref]), "warning")).toContain("image-unpinned");
  });

  it("registryOf and isFloatingImage read the reference like containerd does", () => {
    expect(registryOf("nginx")).toBe("docker.io");
    expect(registryOf("prom/prometheus:v2")).toBe("docker.io");
    expect(registryOf("docker.io/library/nginx")).toBe("docker.io");
    expect(registryOf("quay.io/a/b:1")).toBe("quay.io");
    expect(registryOf("host:5000/a")).toBe("host:5000");
    expect(isFloatingImage("host:5000/a")).toBe(true);
    expect(isFloatingImage("host:5000/a:1")).toBe(false);
    expect(isFloatingImage(`a@sha256:${"0".repeat(64)}`)).toBe(false);
  });
});

describe("environment.setup", () => {
  it("is reported: nothing runs it", () => {
    expect(rules({ env: { setup: "setup.sh" }, files: { "setup.sh": "#!/bin/sh\ntrue\n" } }, "error")).toContain("setup-unsupported");
  });
});

describe("memory-budget", () => {
  it("is silent up to 1024 MB, warns above, fails above 2048 MB", () => {
    expect(rules({ env: { resources: { memoryMb: 1024 } } })).toEqual([]);
    expect(lint({ env: { resources: { memoryMb: 1536 } } }).map((i) => [i.level, i.rule])).toEqual([["warning", "memory-budget"]]);
    expect(lint({ env: { resources: { memoryMb: 4096 } } }).map((i) => [i.level, i.rule])).toEqual([["error", "memory-budget"]]);
  });
});

describe("break-wait-budget", () => {
  const sh = (body: string) => `#!/bin/sh\n${body}\n`;

  it.each([
    ["a counter loop", sh("i=0\nwhile [ $i -lt 100 ]; do\n  ready && exit 0\n  i=$((i + 1)); sleep 3\ndone\nexit 1"), 300],
    ["a one-line loop", sh("i=0; while [ $i -lt 120 ]; do [ -e /run/ok ] && break; i=$((i + 1)); sleep 0.5; done"), 60],
    ["a seq loop", sh("for i in $(seq 1 50); do check && break; sleep 2; done"), 100],
    ["a wall-clock deadline", sh('start=$(date +%s)\nelapsed() { echo $(( $(date +%s) - start )); }\nuntil ready; do\n  [ "$(elapsed)" -ge 195 ] && exit 1\n  sleep 3\ndone'), 195],
    ["the longest of several loops, not their sum", sh("i=0\nwhile [ $i -lt 30 ]; do i=$((i+1)); sleep 3; done\nj=0\nwhile [ $j -lt 40 ]; do j=$((j+1)); sleep 3; done"), 120],
    ["sleeps outside loops add to the loop", sh("sleep 10\nsleep 5\ni=0\nwhile [ $i -lt 10 ]; do i=$((i+1)); sleep 2; done"), 35],
    ["a nested loop counts once, from the outside", sh("i=0\nwhile [ $i -lt 5 ]; do\n  for p in a b; do sleep 1; done\n  i=$((i+1)); sleep 2\ndone"), 15],
    ["commented-out waits", sh("# sleep 500\ntrue"), 0],
    ["no waits at all", sh("kubectl apply -f x"), 0],
  ])("reads %s", (_label, script, seconds) => {
    expect(breakWaitBudgetSec(script)).toBe(seconds);
  });

  it("does not count kubectl's own --timeout", () => {
    expect(breakWaitBudgetSec(sh("kubectl rollout status deploy/x --timeout=180s || true"))).toBe(0);
  });

  it("warns above 240 s and only then", () => {
    const loop = (n: number) => `#!/bin/sh\ni=0\nwhile [ $i -lt ${n} ]; do\n  i=$((i + 1)); sleep 3\ndone\n`;
    expect(rules({ files: { "break.sh": loop(80) } })).toEqual([]);
    expect(rules({ files: { "break.sh": loop(90) } }, "warning")).toContain("break-wait-budget");
  });
});

describe("teaching copy", () => {
  const BRIEF = "> 🎓 **Учебный кейс.** Есть панель помощи.\n\n## Цель\n\nПочинить.\n\n## Шпаргалка\n\n| a | b |\n\n## Почитать заранее\n\n- ссылка\n";
  const guide = (meta: Record<string, unknown> = {}, brief = BRIEF): FixtureOptions => ({
    meta: { guide: "guide.md", difficulty: "JUNIOR", ...meta },
    files: { "guide.md": "## Этап\n\nСмотри логи.\n", "brief.md": brief },
  });

  it("is quiet for a complete teaching scenario", () => {
    expect(rules(guide())).toEqual([]);
  });

  it("asks for difficulty JUNIOR", () => {
    expect(rules(guide({ difficulty: "MIDDLE" }), "warning")).toEqual(["guide-junior"]);
  });

  it("asks for the callout and both reference sections", () => {
    const found = lint(guide({}, "## Цель\n\nПочинить.\n")).filter((i) => i.rule === "tutorial-brief-parts");
    expect(found.map((i) => i.message)).toEqual([expect.stringContaining("🎓"), expect.stringContaining("Шпаргалка"), expect.stringContaining("Почитать заранее")]);
  });

  it("does not ask regular scenarios for any of it", () => {
    expect(rules({ meta: { difficulty: "SENIOR" } })).toEqual([]);
  });
});
