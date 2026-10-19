// Scenario regression (ADR-0005): fresh sandbox -> grader must FAIL; after solve -> grader must PASS.
// Uses the same RuntimeProvider and hardening as the orchestrator (single source of truth).
import { specFromEnvironment, type RuntimeProvider, type SandboxHandle } from "@wom/runtime";
import type { ScenarioBundle } from "./load";
import { parseGrader } from "./grader";
import { publicEnvironment } from "./load";

export type ScenarioTestReport = {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
  timings: { createMs: number; breakMs: number };
};

/** the platform gives break.sh up to 240 s (BREAK_TIMEOUT_MS); the same bound serves every script here */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 240_000;

function noJson(r: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }): string {
  return `no JSON from grader (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}): stdout=${JSON.stringify(r.stdout.slice(-300))} stderr=${JSON.stringify(r.stderr.slice(-300))}`;
}

/** how to remove what `--keep` left behind: the kind cluster, the sandbox container and the network they share */
export function cleanupCommands(h: SandboxHandle): string[] {
  const out: string[] = [];
  if (h.clusterName) out.push(`kind delete cluster --name ${h.clusterName}`);
  if (h.containerId) out.push(`docker rm -f ${h.containerId}`);
  if (h.networkId && h.ownsNetwork !== false) out.push(`docker network rm ${h.networkId}`);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runScenarioTest(
  runtime: RuntimeProvider,
  b: ScenarioBundle,
  opts: {
    timeoutMs?: number;
    /** how long a verdict may lag behind break.sh / solve.sh before it counts as wrong (default 30 s) */
    settleMs?: number;
    /** pause between two grader runs while waiting for the expected verdict (default 3 s) */
    pollMs?: number;
    keep?: boolean;
    log?: (line: string) => void;
  } = {},
): Promise<ScenarioTestReport> {
  const env = b.meta.environment;
  if (!env) throw new Error("text-only scenario: nothing to test");
  if (!b.scripts.check || !b.scripts.solve) throw new Error("check.sh and solve.sh are required");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? 30_000;
  const pollMs = opts.pollMs ?? 3000;
  const log = opts.log ?? (() => {});
  const steps: ScenarioTestReport["steps"] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  };

  const isK8s = env.kind === "kubernetes";
  const newSandbox = () => runtime.create(specFromEnvironment(publicEnvironment(env, b.dir), `test-${b.meta.slug}-${Date.now()}`, { "wom.owner": "cli", "wom.test": "scenario" }));

  // 0. baseline: what the grader says on the UNBROKEN environment (scenario.test.baseline: pass | fail | skip).
  // "fail" is legitimate when the grader demands a state that only exists after the break (e.g. "release 2.4.0 rolled out").
  const baseline = b.meta.test.baseline;
  // The effect of break.sh and solve.sh is not always instant (a rollout, a controller's reconcile loop) and a player's run of
  // the grader sees the same lag: the verdict is polled until it is the expected one or settleMs is over.
  const gradeUntil = async (h: SandboxHandle, want: boolean) => {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const r = await runtime.runScript(h, b.scripts.check!, { user: "root", timeoutMs });
      // a flooded output is only a tail the player could have written: never read as a verdict (as in the orchestrator)
      const g = r.outputTooLarge ? null : parseGrader(r.stdout);
      if (g?.passed === want || Date.now() + pollMs > deadline) return { r, g };
      await sleep(pollMs);
    }
  };
  const baselineStep = async (h: SandboxHandle) => {
    const want = baseline === "pass";
    const base = await gradeUntil(h, want);
    step(`baseline grader on unbroken environment (expect ${baseline})`, base.g?.passed === want, base.g ? `failing: ${base.g.criteria.filter((c) => !c.ok).map((c) => c.id).join(", ") || "none"}` : noJson(base.r));
  };
  // Container scenarios: the orchestrator runs break.sh the moment the container starts. The regression has to do
  // the same, otherwise a break that races with the image's entrypoint passes here and fails for every player.
  // So the baseline gets a sandbox of its own (cheap for a container) and the main one is broken right after create.
  if (!isK8s && baseline !== "skip") {
    const probe = await newSandbox();
    try {
      await new Promise((r) => setTimeout(r, 1500)); // services start via the entrypoint
      await baselineStep(probe);
    } finally {
      await runtime.destroy(probe).catch(() => {});
    }
  }

  const t0 = performance.now();
  const handle: SandboxHandle = await newSandbox();
  const createMs = Math.round(performance.now() - t0);
  let breakMs = 0;
  try {
    const run = (script: string) => runtime.runScript(handle, script, { user: "root", timeoutMs });
    if (isK8s) {
      await new Promise((r) => setTimeout(r, 500)); // manifests are already applied by create()
      if (baseline !== "skip") await baselineStep(handle);
    }

    // 1. break
    if (b.scripts.break) {
      const t1 = performance.now();
      const br = await run(b.scripts.break);
      breakMs = Math.round(performance.now() - t1);
      step("break.sh exits 0", br.exitCode === 0 && !br.timedOut, br.exitCode === 0 ? `${breakMs} ms` : (br.stderr || br.stdout).slice(0, 300));
    }

    // 2. broken -> must fail
    const broken = await gradeUntil(handle, false);
    step("grader fails on broken sandbox", broken.g?.passed === false, broken.g ? `failing: ${broken.g.criteria.filter((c) => !c.ok).map((c) => c.id).join(", ")}` : noJson(broken.r));

    // 3. solve -> must pass
    const sv = await run(b.scripts.solve);
    step("solve.sh exits 0", sv.exitCode === 0 && !sv.timedOut, sv.exitCode === 0 ? "ok" : (sv.stderr || sv.stdout).slice(0, 300));
    const solved = await gradeUntil(handle, true);
    step("grader passes after reference solution", solved.g?.passed === true, solved.g ? (solved.g.passed ? `all ${solved.g.criteria.length} criteria ok` : `still failing: ${solved.g.criteria.filter((c) => !c.ok).map((c) => `${c.id} (${c.message})`).join("; ")}`) : noJson(solved.r));

    // 4. hardening probes
    const ro = await runtime.runScript(handle, "#!/bin/sh\ntouch /usr/bin/.wom-probe 2>&1; echo rc=$?", { user: "root", timeoutMs: 10_000 });
    step("rootfs read-only", /Read-only file system/.test(ro.stdout + ro.stderr), (ro.stdout + ro.stderr).trim().slice(0, 120));
    const pm = await runtime.runScript(handle, "#!/bin/sh\ncommand -v apt-get dpkg apk pip pip3 2>/dev/null; echo done", { user: "root", timeoutMs: 10_000 });
    step("no package managers", pm.stdout.trim() === "done", pm.stdout.trim().replace(/\n/g, " ").slice(0, 120));
    if (env.shell.sudo && env.kind !== "kubernetes") {
      const su = await runtime.runScript(handle, `#!/bin/sh\nsu -s /bin/sh ${env.shell.user} -c 'sudo -n id -u'`, { user: "root", timeoutMs: 10_000 });
      step(`sudo works for ${env.shell.user}`, su.stdout.trim() === "0", (su.stdout + su.stderr).trim().slice(0, 120));
    }
  } finally {
    if (opts.keep) {
      log(`sandbox kept; remove it with:`);
      for (const c of cleanupCommands(handle)) log(`  ${c}`);
    } else await runtime.destroy(handle).catch(() => {});
  }
  return { ok: steps.every((s) => s.ok), steps, timings: { createMs, breakMs } };
}
