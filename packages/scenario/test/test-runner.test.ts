import { FakeRuntimeProvider } from "@wom/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenarioFolder } from "../src/load";
import { parseGrader } from "../src/grader";
import { cleanupCommands, runScenarioTest } from "../src/test-runner";
import { cleanupFixtures, scenarioDir } from "./fixture";

afterAll(cleanupFixtures);

const verdict = (passed: boolean) => JSON.stringify({ passed, criteria: [{ id: "web", ok: passed, message: "" }] }) + "\n";
const out = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

/** a sandbox whose grader says "unsolved" while it is broken; `lag` verdicts after break.sh / solve.sh are still the old ones */
function setup(lag: { afterBreak?: number; afterSolve?: number } = {}) {
  const bundle = loadScenarioFolder(scenarioDir({ kind: "kubernetes" }));
  bundle.scripts = { setup: null, break: "#!/bin/sh\n# BREAK\n", check: "#!/bin/sh\n# CHECK\n", solve: "#!/bin/sh\n# SOLVE\n" };
  const runtime = new FakeRuntimeProvider();
  let broken = false;
  let stale = 0;
  let checks = 0;
  runtime.scriptResponder = (script) => {
    if (script.includes("# BREAK")) {
      broken = true;
      stale = lag.afterBreak ?? 0;
      return out("");
    }
    if (script.includes("# SOLVE")) {
      broken = false;
      stale = lag.afterSolve ?? 0;
      return out("");
    }
    if (script.includes("# CHECK")) {
      checks++;
      if (stale > 0) {
        stale--;
        return out(verdict(broken)); // the old state: what the grader saw before the script took effect
      }
      return out(verdict(!broken));
    }
    return out("done\n");
  };
  return { bundle, runtime, checks: () => checks };
}

const fast = { pollMs: 5, settleMs: 400 };
const stepOk = (r: Awaited<ReturnType<typeof runScenarioTest>>, name: RegExp) => r.steps.find((s) => name.test(s.name))?.ok;

describe("runScenarioTest: verdicts that lag behind the scripts", () => {
  it("passes when the verdicts are immediate", async () => {
    const { bundle, runtime } = setup();
    const r = await runScenarioTest(runtime, bundle, fast);
    expect(stepOk(r, /grader fails on broken/)).toBe(true);
    expect(stepOk(r, /grader passes after reference/)).toBe(true);
  });

  it("waits for the broken verdict instead of failing on the first run", async () => {
    const { bundle, runtime } = setup({ afterBreak: 3 });
    const r = await runScenarioTest(runtime, bundle, fast);
    expect(stepOk(r, /grader fails on broken/)).toBe(true);
  });

  it("waits for the solved verdict instead of failing on the first run", async () => {
    const { bundle, runtime } = setup({ afterSolve: 3 });
    const r = await runScenarioTest(runtime, bundle, fast);
    expect(stepOk(r, /grader passes after reference/)).toBe(true);
  });

  it("gives up when the verdict never changes, and says so", async () => {
    const { bundle, runtime, checks } = setup({ afterSolve: 1_000_000 });
    const r = await runScenarioTest(runtime, bundle, { pollMs: 5, settleMs: 60 });
    expect(stepOk(r, /grader passes after reference/)).toBe(false);
    expect(r.ok).toBe(false);
    expect(checks()).toBeGreaterThan(3);
  });

  it("does not wait at all for a verdict that is already right", async () => {
    const { bundle, runtime, checks } = setup();
    await runScenarioTest(runtime, bundle, { pollMs: 5, settleMs: 5_000 });
    expect(checks()).toBe(3); // baseline, broken, solved
  });
});

describe("runScenarioTest --keep", () => {
  it("leaves the sandbox and prints the commands that remove it", async () => {
    const { bundle, runtime } = setup();
    const lines: string[] = [];
    await runScenarioTest(runtime, bundle, { ...fast, keep: true, log: (l) => lines.push(l) });
    expect(runtime.sandboxes.size).toBe(1);
    expect(lines.join("\n")).toContain("docker rm -f fake-1");
  });

  it("destroys the sandbox otherwise", async () => {
    const { bundle, runtime } = setup();
    await runScenarioTest(runtime, bundle, fast);
    expect(runtime.sandboxes.size).toBe(0);
  });

  it("lists the cluster, the container and an owned network", () => {
    const handle = { provider: "kubernetes" as const, containerId: "abc", networkId: "net1", ownsNetwork: true, clusterName: "wom-k8s-x" };
    expect(cleanupCommands(handle)).toEqual(["kind delete cluster --name wom-k8s-x", "docker rm -f abc", "docker network rm net1"]);
    expect(cleanupCommands({ ...handle, ownsNetwork: false, clusterName: undefined })).toEqual(["docker rm -f abc"]);
  });
});

describe("parseGrader reads what the orchestrator reads", () => {
  it.each([
    ["a criterion without an id", '{"passed": true, "criteria": [{"ok": true}]}'],
    ["a criterion whose ok is not a boolean", '{"passed": true, "criteria": [{"id": "a", "ok": "yes"}]}'],
    ["a criterion that is not an object", '{"passed": true, "criteria": ["a"]}'],
    ["an array instead of an object", "[]"],
  ])("refuses %s", (_label, stdout) => {
    expect(parseGrader(stdout + "\n")).toBeNull();
  });

  it("fills a missing message with an empty string", () => {
    expect(parseGrader('{"passed": true, "criteria": [{"id": "a", "ok": true}]}')).toEqual({ passed: true, criteria: [{ id: "a", ok: true, message: "" }] });
  });
});
