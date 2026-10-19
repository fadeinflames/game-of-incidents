import { afterAll, describe, expect, it } from "vitest";
import { lintBundle } from "../src/lint";
import { loadScenarioFolder } from "../src/load";
import { lintManifests, parseQuantity } from "../src/manifest-lint";
import { cleanupFixtures, scenarioDir } from "./fixture";

afterAll(cleanupFixtures);

const never = () => false;
const run = (content: string, opts: { nodes?: number; isFloating?: (ref: string) => boolean } = {}) =>
  lintManifests([{ name: "app.yaml", content }], { nodes: opts.nodes ?? 1, isFloating: opts.isFloating ?? never });
const rules = (content: string, opts?: Parameters<typeof run>[1]) => run(content, opts).map((i) => i.rule);

const container = (extra = "") => `        - name: web\n          image: nginx:1.27\n          resources:\n            requests: { cpu: 100m, memory: 128Mi }\n            limits: { memory: 256Mi }\n${extra}`;
const deployment = (body: string, replicas = 1) =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec:\n  replicas: ${replicas}\n  template:\n    spec:\n${body}`;

describe("parseQuantity", () => {
  it.each([
    ["250m", "cpu", 0.25],
    ["2", "cpu", 2],
    [0.5, "cpu", 0.5],
    ["128Mi", "memory", 128 * 1024 ** 2],
    ["1Gi", "memory", 1024 ** 3],
    ["500M", "memory", 5e8],
    ["129e6", "memory", 129e6],
    [4096, "memory", 4096],
  ] as const)("reads %s as %s", (value, kind, expected) => {
    expect(parseQuantity(value, kind)).toBe(expected);
  });

  it.each([
    ["lots", "memory"],
    ["12Qi", "memory"],
    ["1.5Gix", "memory"],
    ["250m", "memory"],
    ["1Gi", "cpu"],
    [null, "cpu"],
    [-1, "cpu"],
  ] as const)("refuses %s as %s", (value, kind) => {
    expect(parseQuantity(value, kind)).toBeNull();
  });
});

describe("lintManifests", () => {
  it("is silent about a workload with requests and limits", () => {
    expect(rules(deployment(`      containers:\n${container()}`))).toEqual([]);
  });

  it("names the containers that have no requests or no limits, also in a CronJob", () => {
    const bare = deployment("      containers:\n        - name: web\n          image: nginx:1.27\n");
    expect(run(bare).map((i) => [i.rule, i.level])).toEqual([["manifest-resources", "warning"]]);
    expect(run(bare)[0].message).toContain("Deployment/web:web");
    const noLimits = deployment("      containers:\n        - name: web\n          image: nginx:1.27\n          resources:\n            requests: { cpu: 10m, memory: 8Mi }\n");
    expect(rules(noLimits)).toEqual(["manifest-resources"]);
    const cron = "kind: CronJob\nmetadata: { name: nightly }\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n            - name: job\n              image: nginx:1.27\n";
    expect(run(cron)[0].message).toContain("CronJob/nightly:job");
  });

  it("does not mistake a ConfigMap or a Service for a workload", () => {
    expect(rules("kind: ConfigMap\nmetadata: { name: c }\ndata: { image: nginx }\n---\nkind: Service\nspec: { ports: [{ port: 80 }] }\n")).toEqual([]);
  });

  describe("privileged and host access", () => {
    const priv = (note: string) => deployment(`      containers:\n${container(`          securityContext:\n            privileged: true${note}\n`)}`);

    it("warns about privileged: true without a reason", () => {
      const found = run(priv(""));
      expect(found.map((i) => i.rule)).toEqual(["manifest-privileged"]);
      expect(found[0].message).toContain("app.yaml");
    });

    it("accepts a reason on the same line or in the comment lines right above", () => {
      expect(rules(priv("  # programs iptables of the node"))).toEqual([]);
      const above = deployment(`      containers:\n${container("          securityContext:\n            # the agent changes iptables of the node,\n            # a plain container cannot\n            privileged: true\n")}`);
      expect(rules(above)).toEqual([]);
    });

    it("does not take a one-word or a distant comment for a reason", () => {
      expect(rules(priv("  # yes"))).toEqual(["manifest-privileged"]);
      const distant = deployment(`      containers:\n${container("          # needed for iptables of the node\n          securityContext:\n            privileged: true\n")}`);
      expect(rules(distant)).toEqual(["manifest-privileged"]);
    });

    it("ignores the word in a comment line", () => {
      expect(rules(`# privileged: true is not used here\n${deployment(`      containers:\n${container()}`)}`)).toEqual([]);
    });

    it("warns about hostPath and host namespaces, once per file and kind", () => {
      const pv = "kind: PersistentVolume\nspec:\n  hostPath: { path: /a }\n---\nkind: PersistentVolume\nspec:\n  hostPath: { path: /b }\n---\nkind: Pod\nspec:\n  hostNetwork: true\n";
      const found = run(pv);
      expect(found.map((i) => i.rule)).toEqual(["manifest-host-access", "manifest-host-access"]);
      expect(found[0].message).toContain("line 3, 7");
    });
  });

  describe("images", () => {
    const pod = (image: string) => `kind: Pod\nmetadata: { name: p }\nspec:\n  containers:\n    - name: c\n      image: ${image}\n      resources:\n        requests: { cpu: 1m, memory: 1Mi }\n        limits: { memory: 8Mi }\n`;
    const floating = (ref: string) => !/:[^/:]+$/.test(ref) || ref.endsWith(":latest");

    it("warns about an image without a tag and about :latest", () => {
      expect(rules(pod("nginx"), { isFloating: floating })).toEqual(["manifest-image-unpinned"]);
      expect(rules(pod("nginx:latest"), { isFloating: floating })).toEqual(["manifest-image-unpinned"]);
      expect(rules(pod("nginx:1.27"), { isFloating: floating })).toEqual([]);
    });

    it("reports one image once, however many containers use it", () => {
      expect(rules(`${pod("nginx")}---\n${pod("nginx")}`, { isFloating: floating })).toEqual(["manifest-image-unpinned"]);
    });
  });

  describe("the budget of a kind node", () => {
    const sized = (mem: string, cpu: string, replicas: number) =>
      deployment(`      containers:\n        - name: web\n          image: nginx:1.27\n          resources:\n            requests: { cpu: ${cpu}, memory: ${mem} }\n            limits: { memory: ${mem} }\n`, replicas);

    it("is quiet while the requests fit into one node", () => {
      expect(rules(sized("1Gi", "500m", 3))).toEqual([]);
    });

    it("warns when the memory requests do not fit, counting replicas", () => {
      const found = run(sized("1Gi", "100m", 5));
      expect(found.map((i) => i.rule)).toEqual(["manifest-requests-budget"]);
      expect(found[0].message).toContain("5120 MiB");
    });

    it("warns when the CPU requests do not fit", () => {
      expect(rules(sized("64Mi", "1", 3))).toEqual(["manifest-requests-budget"]);
    });

    it("counts every node of the cluster", () => {
      expect(rules(sized("1Gi", "100m", 5), { nodes: 2 })).toEqual([]);
      expect(rules(sized("1Gi", "100m", 9), { nodes: 2 })).toEqual(["manifest-requests-budget"]);
    });

    it("runs a DaemonSet on every node", () => {
      const ds = "kind: DaemonSet\nmetadata: { name: agent }\nspec:\n  template:\n    spec:\n      containers:\n        - name: a\n          image: nginx:1.27\n          resources:\n            requests: { cpu: 10m, memory: 3000Mi }\n            limits: { memory: 3000Mi }\n";
      const web = sized("1536Mi", "10m", 2);
      expect(rules(ds, { nodes: 2 })).toEqual([]);
      // 2 x 3000 MiB + 2 x 1536 MiB is more than the 8192 MiB of two nodes
      expect(rules(`${ds}---\n${web}`, { nodes: 2 })).toEqual(["manifest-requests-budget"]);
      expect(rules(`${ds}---\n${web}`, { nodes: 3 })).toEqual([]);
    });
  });

  it("reports a file that is not YAML instead of failing", () => {
    expect(rules("kind: Pod\n  : : [\n")).toEqual(["manifest-yaml"]);
  });

  it("skips the content rules for a manifest of a size the size rule refuses", () => {
    const big = `# ${"x".repeat(5 * 1024 * 1024)}\nkind: Pod\nspec:\n  containers:\n    - name: c\n      image: a\n`;
    expect(rules(big)).toEqual([]);
  });
});

describe("lintBundle with the manifest rules", () => {
  it("reports them as warnings, never as errors", () => {
    const b = loadScenarioFolder(
      scenarioDir({
        kind: "kubernetes",
        files: { "k8s/app.yaml": "kind: Pod\nmetadata: { name: p }\nspec:\n  hostNetwork: true\n  containers:\n    - name: c\n      image: wom-scenario/demo-case:dev\n" },
      }),
    );
    const found = lintBundle(b);
    expect(found.map((i) => i.rule).sort()).toEqual(["manifest-host-access", "manifest-resources"]);
    expect(found.every((i) => i.level === "warning")).toBe(true);
  });

  it("does not repeat an unpinned image that environment.images already reports", () => {
    const b = loadScenarioFolder(
      scenarioDir({
        kind: "kubernetes",
        env: { images: ["wom-scenario/demo-case:dev", "nginx"] },
        files: { "k8s/web.yaml": "kind: Pod\nmetadata: { name: p }\nspec:\n  containers:\n    - name: c\n      image: nginx\n      resources:\n        requests: { cpu: 1m, memory: 1Mi }\n        limits: { memory: 8Mi }\n" },
      }),
    );
    expect(lintBundle(b).map((i) => i.rule)).toEqual(["image-unpinned"]);
  });

  it("an image only the manifest names is reported by the manifest rule", () => {
    const b = loadScenarioFolder(
      scenarioDir({
        kind: "kubernetes",
        env: { images: ["wom-scenario/demo-case:dev", "nginx:1.27"] },
        files: { "k8s/web.yaml": "kind: Pod\nmetadata: { name: p }\nspec:\n  containers:\n    - name: c\n      image: nginx:1.27\n      resources:\n        requests: { cpu: 1m, memory: 1Mi }\n        limits: { memory: 8Mi }\n    - name: d\n      image: wom-scenario/demo-case\n      resources:\n        requests: { cpu: 1m, memory: 1Mi }\n        limits: { memory: 8Mi }\n" },
      }),
    );
    expect(lintBundle(b).map((i) => i.rule)).toEqual(["manifest-image-unpinned"]);
  });
});
