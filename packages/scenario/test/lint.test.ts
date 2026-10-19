import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ALLOWED_BASE_IMAGES, disallowedDockerfileImages, graderRcFileReaders, lintBundle, manifestImages } from "../src/lint";
import { loadScenarioFolder } from "../src/load";
import { cleanupFixtures, scenarioDir, type FixtureOptions } from "./fixture";

afterAll(cleanupFixtures);

const lint = (opts: FixtureOptions = {}) => lintBundle(loadScenarioFolder(scenarioDir(opts)));
const rules = (opts: FixtureOptions = {}, level?: "error" | "warning") =>
  lint(opts)
    .filter((i) => !level || i.level === level)
    .map((i) => i.rule);

const GRADER_TAIL = `printf '{"passed": true, "criteria": []}\\n'\n`;
const RESOURCES = "      resources:\n        requests: { cpu: 10m, memory: 16Mi }\n        limits: { memory: 64Mi }\n";
const pod = (image: string) => `kind: Pod\nspec:\n  containers:\n    - name: app\n      image: ${image}\n${RESOURCES}`;

describe("lintBundle: clean scenarios", () => {
  it("has nothing to say about the container fixture", () => {
    expect(lint()).toEqual([]);
  });

  it("has nothing to say about the kubernetes fixture", () => {
    expect(lint({ kind: "kubernetes" })).toEqual([]);
  });

  // a new rule must not break the published catalog: every scenario in the repository stays free of errors
  const catalog = fileURLToPath(new URL("../../../scenarios", import.meta.url));
  const slugs = readdirSync(catalog).filter((d) => existsSync(path.join(catalog, d, "scenario.yaml")));
  it("finds the catalog", () => {
    expect(slugs).toEqual(expect.arrayContaining(["nginx-502-upstream", "broken-probes"]));
  });
  it.each(slugs)("reports no errors for scenarios/%s", (slug) => {
    expect(lintBundle(loadScenarioFolder(path.join(catalog, slug))).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("lintBundle: one rule per broken fixture", () => {
  const cases: [string, "error" | "warning", FixtureOptions][] = [
    ["hints-contiguous", "error", { meta: { hintsJson: [{ level: 1, text: "Направление" }, { level: 3, text: "Почти ответ" }, { level: 4, text: "Ответ целиком" }] } }],
    ["hints-penalty-order", "warning", { meta: { hintsJson: [{ level: 1, penalty: 10, text: "Направление" }, { level: 2, penalty: 5, text: "Инструмент" }, { level: 3, penalty: 15, text: "Почти ответ" }] } }],
    ["hints-three-levels", "warning", { meta: { hintsJson: [{ level: 1, text: "Направление" }] } }],
    ["kind-unsupported", "error", { env: { kind: "compose" } }],
    ["k8s-fields", "warning", { env: { images: ["nginx:1.27"] } }],
    ["k8s-manifests", "error", { kind: "kubernetes", env: { manifests: "./missing" } }],
    ["k8s-manifests", "error", { kind: "kubernetes", files: { "k8s/app.yaml": null, "k8s/readme.txt": "no manifests here\n" } }],
    ["k8s-build", "error", { kind: "kubernetes", env: { images: [] } }],
    ["k8s-kubectl", "warning", { kind: "kubernetes", files: { "solve.sh": "#!/bin/sh\ntrue\n" } }],
    ["k8s-shell-user", "warning", { kind: "kubernetes", env: { shell: { user: "root" } } }],
    ["file-missing", "error", { files: { "debrief.md": null } }],
    ["brief-required", "error", { meta: { brief: undefined } }],
    ["debrief-required", "error", { meta: { debrief: undefined } }],
    ["guide-stages", "error", { meta: { guide: "guide.md" }, files: { "guide.md": "Просто текст без этапов.\n" } }],
    ["tutorial-tag", "warning", { meta: { tags: ["tutorial"] } }],
    ["slug-reserved", "error", { meta: { slug: "demo-case-tutorial" }, env: { image: "wom-scenario/demo-case-tutorial:dev" } }],
    ["build-dockerfile", "error", { files: { "image/Dockerfile": null } }],
    ["image-tag-namespace", "error", { env: { image: "wom-scenario/someone-else:dev" } }],
    ["script-posix-sh", "error", { files: { "break.sh": "#!/bin/bash\ntrue\n" } }],
    ["script-crlf", "error", { files: { "break.sh": "#!/bin/sh\r\ntrue\r\n" } }],
    ["grader-json", "error", { files: { "check.sh": "#!/bin/sh\necho ok\n" } }],
    ["grader-independent", "warning", { files: { "check.sh": `#!/bin/sh\n# compares with solve.sh\n${GRADER_TAIL}` } }],
    ["writable-immutable", "error", { env: { writable: ["/usr/local"] } }],
    ["writable-root", "error", { env: { writable: ["/"] } }],
    ["tmpfs-under-writable", "warning", { env: { tmpfs: { "/var/lib/data": "size=64m" } } }],
    ["tmpfs-immutable", "error", { env: { tmpfs: { "/usr/share": "size=64m" } } }],
    ["cap-forbidden", "error", { env: { capabilities: ["SYS_ADMIN"] } }],
    ["egress-unsupported", "warning", { env: { network: { egress: "allowlist" } } }],
    ["ttl-too-short", "error", { meta: { durationMin: 60 }, env: { ttlMin: 30 } }],
    ["sudo-as-root", "warning", { env: { shell: { user: "root", sudo: true } } }],
    ["image-package-managers", "warning", { files: { "image/Dockerfile": "FROM debian:bookworm-slim\n" } }],
    ["image-forbidden", "error", { files: { "image/Dockerfile": "FROM debian:bookworm-slim\nRUN rm -f /usr/bin/apt\nVOLUME /var/run/docker.sock\n" } }],
    ["break-package-manager", "warning", { files: { "break.sh": "#!/bin/sh\napt-get install -y stress\n" } }],
    ["image-base", "error", { files: { "image/Dockerfile": "FROM ubuntu:24.04\nRUN rm -f /usr/bin/apt\n" } }],
    ["image-base", "error", { kind: "kubernetes", files: { "image/Dockerfile": "FROM node:22-alpine\n" } }],
    ["k8s-images-listed", "error", { kind: "kubernetes", files: { "k8s/db.yaml": pod("postgres:16-alpine") } }],
    ["grader-psql-rc", "warning", { files: { "check.sh": `#!/bin/sh\npsql -U shop -tAc 'select 1' >/dev/null\n${GRADER_TAIL}` } }],
    ["grader-curl-rc", "warning", { files: { "check.sh": `#!/bin/sh\ncurl -s http://127.0.0.1/ >/dev/null\n${GRADER_TAIL}` } }],
  ];

  it.each(cases)("%s (%s)", (rule, level, opts) => {
    expect(rules(opts, level)).toContain(rule);
  });

  it("text-only scenarios are checked for hints only", () => {
    const dir = scenarioDir({ files: { "scenario.yaml": "version: 2\nslug: text-only\ntitle: Text only\nsummary: A tabletop scenario.\ntype: tabletop\ndifficulty: MIDDLE\ndurationMin: 20\n" } });
    expect(lintBundle(loadScenarioFolder(dir))).toEqual([]);
  });
});

describe("lintBundle: capabilities", () => {
  it("forbids a capability however it is spelled, even when the schema is bypassed", () => {
    for (const spelling of ["CAP_SYS_ADMIN", "cap_sys_admin", " sys_admin", "CAP_CAP_NET_ADMIN"]) {
      const b = loadScenarioFolder(scenarioDir());
      b.meta.environment!.capabilities = [spelling];
      expect(lintBundle(b).map((i) => i.rule)).toContain("cap-forbidden");
    }
  });

  it("accepts a harmless capability", () => {
    expect(rules({ env: { capabilities: ["NET_BIND_SERVICE"] } })).toEqual([]);
  });
});

describe("k8s-images-listed", () => {
  const k8s = (manifest: string, images: string[] = []) => rules({ kind: "kubernetes", env: { images: ["wom-scenario/demo-case:dev", ...images] }, files: { "k8s/extra.yaml": manifest } }, "error");

  it("accepts images that are listed, in any spelling containerd treats as equal", () => {
    expect(k8s(pod("postgres:16-alpine"), ["postgres:16-alpine"])).toEqual([]);
    expect(k8s(pod("nginx:1.27"), ["docker.io/library/nginx:1.27"])).toEqual([]);
    expect(k8s(pod("docker.io/prom/prometheus:v2.55.1"), ["prom/prometheus:v2.55.1"])).toEqual([]);
    expect(k8s(pod('"quay.io/jetstack/cert-manager-webhook:v1.17.2"'), ["quay.io/jetstack/cert-manager-webhook:v1.17.2"])).toEqual([]);
  });

  it("does not require scenario images to be repeated", () => {
    expect(k8s(pod("wom-scenario/demo-case:v2"))).toEqual([]);
  });

  it("reports an image a controller starts on its own through a flag", () => {
    const manifest = `${pod("quay.io/jetstack/cert-manager-controller:v1.17.2")}      args:\n        - --acme-http01-solver-image=quay.io/jetstack/cert-manager-acmesolver:v1.17.2\n`;
    const issues = lint({ kind: "kubernetes", env: { images: ["wom-scenario/demo-case:dev", "quay.io/jetstack/cert-manager-controller:v1.17.2"] }, files: { "k8s/cm.yaml": manifest } });
    expect(issues.map((i) => i.rule)).toEqual(["k8s-images-listed"]);
    expect(issues[0].message).toContain("cm.yaml: image quay.io/jetstack/cert-manager-acmesolver:v1.17.2");
  });

  it("treats a different tag as a different image", () => {
    expect(k8s(pod("postgres:17-alpine"), ["postgres:16-alpine"])).toEqual(["k8s-images-listed"]);
    expect(k8s(pod("postgres"), ["postgres:16-alpine"])).toEqual(["k8s-images-listed"]);
  });

  it("finds images in every manifest form", () => {
    expect(manifestImages("containers:\n- image: a/b:1\n  name: x\n")).toEqual(["a/b:1"]);
    expect(manifestImages("containers: [{ name: x, image: a/b:2 }, { image: 'c/d:3', name: y }]\n")).toEqual(["a/b:2", "c/d:3"]);
    expect(manifestImages('{"spec": {"containers": [{"name": "x", "image": "a/b:4"}]}}\n')).toEqual(["a/b:4"]);
    expect(manifestImages("args: [--sidecar-image=e/f:5, --prometheus-config-reloader-image=g/h:6]\n")).toEqual(["e/f:5", "g/h:6"]);
  });

  it("ignores comments, schema descriptions and templated values", () => {
    expect(manifestImages("# image: commented/out:1\n")).toEqual([]);
    expect(manifestImages("image:\n  description: Container image name.\n  type: string\n")).toEqual([]);
    expect(manifestImages("image: $(APP_IMAGE)\nimage: {{ .Values.image }}\n")).toEqual([]);
  });
});

describe("image-base", () => {
  it("allows the listed bases, pinned digests, flags and stages of the same Dockerfile", () => {
    for (const base of ALLOWED_BASE_IMAGES) expect(disallowedDockerfileImages(`FROM ${base}\n`)).toEqual([]);
    expect(disallowedDockerfileImages(`FROM alpine:3.20@sha256:${"a".repeat(64)}\n`)).toEqual([]);
    expect(disallowedDockerfileImages("FROM --platform=linux/amd64 python:3.12-alpine AS build\nFROM alpine:3.20\nCOPY --from=build /app /app\nCOPY --from=0 /x /x\n")).toEqual([]);
    expect(disallowedDockerfileImages("FROM python:3.12-alpine AS Build\nFROM build\n")).toEqual([]);
    expect(disallowedDockerfileImages("FROM python:3.12-alpine \\\n  AS build\nFROM alpine:3.20\nCOPY --from=0 /app /app\n")).toEqual([]);
    expect(disallowedDockerfileImages("FROM debian:bookworm-slim\nRUN apt-get update && \\\n    # tools\n\n    apt-get install -y nginx && \\\n    rm -f /usr/bin/apt\n")).toEqual([]);
  });

  it.each([
    ["another image", "FROM ubuntu:24.04\n", ["ubuntu:24.04"]],
    ["another tag of an allowed image", "FROM debian:latest\n", ["debian:latest"]],
    ["lower-case instruction", "from ghcr.io/evil/image:1\n", ["ghcr.io/evil/image:1"]],
    ["indented instruction", "  FROM evil/image\n", ["evil/image"]],
    ["second stage", "FROM alpine:3.20 AS a\nFROM evil/image AS b\n", ["evil/image"]],
    ["build argument", "ARG BASE=alpine:3.20\nFROM ${BASE}\n", ["${BASE}"]],
    ["line continuation", "FROM \\\n  evil/image\n", ["\\", "evil/image"]],
    ["FROM split inside the keyword", "FR\\\nOM evil/image\n", ["evil/image", "FR\\"]],
    ["FROM split right after the keyword", "FROM\\\n evil/image\n", ["evil/image", "FROM\\"]],
    ["a comment inside the split", "fr\\\r\n  # note\n\nom evil/image\n", ["evil/image", "fr\\"]],
    ["a stage used before it is defined", "FROM docker\nFROM alpine:3.20 AS docker\n", ["docker"]],
    ["COPY --from a stage defined later", "FROM alpine:3.20\nCOPY --from=tools /x /x\nFROM alpine:3.20 AS tools\n", ["tools"]],
    ["COPY --from split by a continuation", "FROM alpine:3.20\nCOPY --fr\\\nom=evil/image:3 /x /x\n", ["evil/image:3"]],
    ["COPY --from an image", "FROM alpine:3.20\nCOPY --from=evil/image:1 /bin/x /bin/x\n", ["evil/image:1"]],
    ["RUN --mount from an image", "FROM alpine:3.20\nRUN --mount=type=bind,from=evil/image:2,target=/m true\n", ["evil/image:2"]],
    ["custom frontend", "# syntax=evil/frontend:1\nFROM alpine:3.20\n", ["# syntax=evil/frontend:1"]],
    ["custom frontend behind //", "//syntax=evil/frontend:1\nFROM alpine:3.20\n", ["//syntax=evil/frontend:1"]],
    ["custom frontend in a JSON document", '{"syntax": "evil/frontend:1"}\n', ["(no FROM instruction)"]],
    ["another escape character", "# escape=`\nFROM alpine:3.20\n", ["# escape=`"]],
    ["an empty file", "", ["(no FROM instruction)"]],
  ])("reports %s", (_label, dockerfile, bad) => {
    expect(disallowedDockerfileImages(dockerfile)).toEqual(bad);
  });
});

describe("grader rc files", () => {
  it.each([
    ["psql without -X", "psql -q -h 127.0.0.1 -U shop -tAc 'select 1'", ["psql"]],
    ["psql by absolute path", "if /usr/bin/psql -U shop -c 'select 1' | grep -q 1; then ok=true; fi", ["psql"]],
    ["psql inside kubectl exec", "n=$(kubectl exec postgres-0 -- psql -U billing -tA -c \"select count(*) from t\")", ["psql"]],
    ["psql inside sh -c", "kubectl exec db-0 -- sh -c 'psql -U app -c \"select 1\"'", ["psql"]],
    ["psql fed by a here-document", "sudo -u postgres psql <<EOF\nselect 1;\nEOF", ["psql"]],
    ["curl without -q", "code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)", ["curl"]],
    ["curl with -q not first", "curl -s -q http://127.0.0.1/", ["curl"]],
    ["curl -X is not psql -X", "curl -s -X POST http://127.0.0.1/order; psql -U shop -c 'select 1'", ["psql", "curl"]],
    ["both across a continuation", "psql -U shop \\\n  -c 'select 1'\ncurl http://127.0.0.1/", ["psql", "curl"]],
  ])("flags %s", (_label, line, tools) => {
    expect(graderRcFileReaders(`#!/bin/sh\n${line}\n`)).toEqual(tools);
  });

  it.each([
    ["psql -X", "psql -X -q -U shop -tAc 'select 1'"],
    ["psql with -X inside a flag group", "psql -XtA -U shop -c 'select 1'"],
    ["psql --no-psqlrc", "/usr/bin/psql --no-psqlrc -U shop -c 'select 1'"],
    ["psql -X fed by a here-document", "psql -X -U shop <<EOF\nselect 1;\nEOF"],
    ["curl -q first", "code=$(curl -q -s -o /dev/null http://127.0.0.1/)"],
    ["curl --disable first", "curl --disable -fsS http://127.0.0.1/"],
    ["a lookup", "command -v psql >/dev/null || exit 1\nwhich curl >/dev/null"],
    ["a comment", "# psql -U shop would read ~/.psqlrc\n  # curl -s too"],
    ["a message", "fail db 'psql недоступен'\nfail web \"curl не отвечает\""],
    ["another tool with a similar name", "my-psql -U x\nxcurl -s y\npsql_ready=1\ncurl_ok=true"],
  ])("accepts %s", (_label, line) => {
    expect(graderRcFileReaders(`#!/bin/sh\n${line}\n`)).toEqual([]);
  });
});
