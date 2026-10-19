import { describe, expect, it } from "vitest";
import { IMAGE_REF_RE, environmentSchema, scenarioV2Schema } from "../src/schema";

const env = (over: Record<string, unknown> = {}) => environmentSchema.safeParse({ image: "wom-tools:dev", check: "check.sh", solve: "solve.sh", ...over });
const paths = (r: ReturnType<typeof env>) => (r.success ? [] : r.error.issues.map((i) => i.path.join(".")));

describe("environment.cluster.nodeImage", () => {
  it("defaults to a kindest/node release", () => {
    const r = env({ kind: "kubernetes", cluster: {} });
    expect(r.success && r.data.cluster?.nodeImage).toMatch(/^kindest\/node:v\d+\.\d+\.\d+$/);
  });

  it.each(["kindest/node:v1.37.0", "kindest/node:v1.31.12", `kindest/node:v1.37.0@sha256:${"0123456789abcdef".repeat(4)}`])("accepts %s", (nodeImage) => {
    expect(env({ cluster: { nodeImage } }).success).toBe(true);
  });

  it.each([
    ["YAML injection through a newline", "kindest/node:v1.37.0\n    extraMounts:\n      - hostPath: /home/wom\n        containerPath: /host"],
    ["trailing newline", "kindest/node:v1.37.0\n"],
    ["another repository", "evil/node:v1.37.0"],
    ["a registry prefix", "docker.io/kindest/node:v1.37.0"],
    ["a floating tag", "kindest/node:latest"],
    ["no tag", "kindest/node"],
    ["a partial version", "kindest/node:v1.37"],
    ["a suffix after the version", "kindest/node:v1.37.0-evil"],
    ["a short digest", "kindest/node:v1.37.0@sha256:abc"],
    ["a YAML comment", "kindest/node:v1.37.0 # x"],
  ])("rejects %s", (_label, nodeImage) => {
    expect(paths(env({ cluster: { nodeImage } }))).toEqual(["cluster.nodeImage"]);
  });
});

describe("environment.image and environment.images", () => {
  const good = [
    "wom-tools:dev",
    "wom-scenario/nginx-502-upstream:dev",
    "postgres:16-alpine",
    "nginx",
    "prom/prometheus:v2.55.1",
    "registry.k8s.io/ingress-nginx/controller:v1.12.1",
    "quay.io/jetstack/cert-manager-acmesolver:v1.17.2",
    "ghcr.io/letsencrypt/pebble:latest",
    "localhost:5000/team/app_name:1.0",
    `registry.k8s.io/coredns/coredns:v1.14.6@sha256:${"ab".repeat(32)}`,
    `alpine@sha256:${"ab".repeat(32)}`,
  ];
  const bad: [string, string][] = [
    ["a space", "nginx :1.27"],
    ["a newline", "nginx:1.27\nprivileged: true"],
    ["a trailing newline", "nginx:1.27\n"],
    ["a tab", "nginx\t:1"],
    ["double quotes", '"nginx:1.27"'],
    ["single quotes", "'nginx:1.27'"],
    ["a NUL byte", "nginx\0:1"],
    ["an escape character", "nginx:1.27\u001b[0m"],
    ["shell substitution", "nginx:$(id)"],
    ["a docker flag", "--privileged"],
    ["upper case in the name", "Nginx:1.27"],
    ["a leading slash", "/nginx:1.27"],
    ["an empty path component", "quay.io//nginx:1.27"],
    ["an empty tag", "nginx:"],
    ["a short digest", "nginx@sha256:abc"],
    ["more than 200 characters", `${"a".repeat(201)}:1`],
  ];

  it.each(good)("accepts %s", (image) => {
    expect(IMAGE_REF_RE.test(image)).toBe(true);
    expect(env({ image, kind: "kubernetes", images: [image] }).success).toBe(true);
  });

  it.each(bad)("rejects %s as the image", (_label, image) => {
    expect(paths(env({ image }))).toContain("image");
  });

  it.each(bad)("rejects %s in images", (_label, image) => {
    expect(paths(env({ kind: "kubernetes", images: ["wom-scenario/demo:dev", image] }))).toContain("images.1");
  });

  it("limits the list to 20 images", () => {
    expect(env({ images: Array.from({ length: 21 }, (_, i) => `img${i}:1`) }).success).toBe(false);
  });
});

describe("environment.capabilities", () => {
  it.each(["NET_BIND_SERVICE", "CHOWN", "SETUID", "SYS_ADMIN"])("accepts the bare upper-case name %s (the linter decides which are forbidden)", (cap) => {
    expect(env({ capabilities: [cap] }).success).toBe(true);
  });

  it.each(["CAP_SYS_ADMIN", "CAP_NET_ADMIN", "CAP_", "cap_sys_admin", "sys_admin", "Sys_Admin", " SYS_ADMIN", "SYS_ADMIN ", "SYS-ADMIN", "_ADMIN", "A", "", "ALL\n"])("rejects %j", (cap) => {
    expect(paths(env({ capabilities: [cap] }))).toEqual(["capabilities.0"]);
  });
});

describe("scenarioV2Schema", () => {
  const base = { version: 2, slug: "demo-case", title: "Demo", summary: "The service answers 502.", type: "linux", difficulty: "MIDDLE", durationMin: 20 };

  it("fills defaults for a text-only scenario", () => {
    const r = scenarioV2Schema.parse(base);
    expect(r.environment).toBeNull();
    expect(r.test).toEqual({ baseline: "pass" });
    expect(r.hintsJson).toEqual([]);
  });

  it("rejects unknown keys at both levels", () => {
    expect(scenarioV2Schema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(env({ resources: { cpus: 1, memoryMb: 512, pids: 256 }, diskMb: 100 }).success).toBe(false);
  });

  it("carries the image rules into a full scenario", () => {
    const r = scenarioV2Schema.safeParse({ ...base, environment: { kind: "kubernetes", image: "wom-tools:dev", check: "check.sh", solve: "solve.sh", cluster: { nodeImage: "kindest/node:v1.37.0\nextra: 1" } } });
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join("."))).toEqual(["environment.cluster.nodeImage"]);
  });
});
