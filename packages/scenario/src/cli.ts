// `wom scenario <lint|build|test|run|export> <dir...>` — author's toolbox (ADR-0005, slice 2).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DockerRuntimeProvider, KubernetesRuntimeProvider, RuntimeRegistry, specFromEnvironment, shellFromEnvironment } from "@wom/runtime";
import { lintBundle } from "./lint";
import { loadScenarioFolder, publicEnvironment, ScenarioLoadError, toImportRecord } from "./load";
import { pythonSyntaxIssues } from "./pycheck";
import { packScenarioDir, pushScenario } from "./push";
import { DEFAULT_SCRIPT_TIMEOUT_MS, runScenarioTest } from "./test-runner";

const usage = `usage:
  wom scenario lint   <dir...>            validate scenario.yaml, files, scripts, hardening rules
  wom scenario build  <dir...>            docker build the scenario image (environment.build -> environment.image)
  wom scenario test   <dir...> [--keep]   regression: fresh -> grader fails, solve -> grader passes, hardening probes; --keep leaves the sandbox
                                          and prints the commands that remove it
  wom scenario run    <dir> [--solve]     hardened sandbox + break, then an interactive shell (docker exec -it); --solve applies solve.sh first
  test and run take --timeout <sec> for one script (default ${DEFAULT_SCRIPT_TIMEOUT_MS / 1000}, what the platform gives break.sh)
  wom scenario export <dir...> -o out.json   write an import file (schema v2) for POST /api/import
  wom scenario push   <dir> [--url https://host] [--check] [--publish] [--start] [--wait <sec>]
                                          send the folder to a running platform (cabinet API): upload; --check = build + regression there
                                          (administrator); --publish = publish after a passed check; --start = also start a session
                                          exit codes: 0 done, 1 failed, 3 uploaded but the account is not an administrator (a moderator continues)

env: DOCKER_HOST (sandbox daemon), e.g. unix:///run/user/1000/docker.sock
     push: WOM_URL (or --url), WOM_USER and WOM_PASSWORD of the platform account (read from the environment only, never printed)`;

function socketPath(): string {
  const h = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
  if (!h.startsWith("unix://")) throw new Error("only unix:// DOCKER_HOST is supported");
  return h.replace(/^unix:\/\//, "");
}

function makeRuntime() {
  const docker = new DockerRuntimeProvider(socketPath());
  const kubernetes = new KubernetesRuntimeProvider(docker, { kindBin: process.env.KIND_BIN ?? "kind", toolsImage: process.env.TOOLS_IMAGE ?? "wom-tools:dev" });
  return new RuntimeRegistry({ docker, kubernetes });
}

function loadOrDie(dir: string) {
  try {
    return loadScenarioFolder(dir);
  } catch (e) {
    if (e instanceof ScenarioLoadError) {
      console.error(`✗ ${dir}: ${e.message}`);
      for (const i of e.issues) console.error(`    - ${i}`);
      process.exit(1);
    }
    throw e;
  }
}

function docker(args: string[], opts: { inherit?: boolean } = {}) {
  const r = spawnSync("docker", args, { stdio: opts.inherit ? "inherit" : "pipe", encoding: "utf8" });
  if (r.status !== 0 && !opts.inherit) throw new Error(`docker ${args[0]} failed: ${r.stderr}`);
  return r;
}

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv;
  if (group !== "scenario" || !cmd) {
    console.log(usage);
    process.exit(cmd ? 1 : 0);
  }
  const flags = new Set<string>();
  const dirs: string[] = [];
  let outFile: string | null = null;
  let timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS;
  let pushUrl = process.env.WOM_URL ?? "";
  let waitSec = 900;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-o") outFile = rest[++i] ?? null;
    else if (a === "--url") pushUrl = rest[++i] ?? "";
    else if (a === "--wait") {
      waitSec = Number(rest[++i]);
      if (!Number.isFinite(waitSec) || waitSec < 1) throw new Error("--wait needs a number of seconds");
    }
    else if (a === "--timeout") {
      const sec = Number(rest[++i]);
      if (!Number.isFinite(sec) || sec < 1) throw new Error("--timeout needs a number of seconds");
      timeoutMs = Math.round(sec * 1000);
    } else if (a.startsWith("--")) flags.add(a);
    else dirs.push(a);
  }
  if (!dirs.length) {
    console.error("no scenario dir given\n" + usage);
    process.exit(1);
  }

  let failed = false;

  if (cmd === "lint") {
    for (const dir of dirs) {
      const b = loadOrDie(dir);
      // the CLI runs on a dev host, the linter in the web app does not: the Python syntax check lives here
      const env = b.meta.environment;
      const issues = [...lintBundle(b), ...(env?.build ? pythonSyntaxIssues(path.resolve(b.dir, env.build)) : [])];
      const errors = issues.filter((i) => i.level === "error");
      for (const i of issues) console.log(`  ${i.level === "error" ? "✗" : "!"} [${i.rule}] ${i.message}`);
      console.log(`${errors.length ? "✗" : "✓"} ${b.meta.slug}: ${errors.length} error(s), ${issues.length - errors.length} warning(s)`);
      if (errors.length) failed = true;
    }
  } else if (cmd === "build") {
    for (const dir of dirs) {
      const b = loadOrDie(dir);
      const env = b.meta.environment;
      if (!env?.build) {
        console.log(`- ${b.meta.slug}: no environment.build, skipping`);
        continue;
      }
      // container: the sandbox image; kubernetes: the scenario app image (first of `images`), the tools image is platform-wide
      const tag = env.kind === "kubernetes" ? (env.images[0] ?? env.image) : env.image;
      console.log(`== build ${tag} from ${path.join(dir, env.build)}`);
      const r = docker(["build", "-t", tag, path.join(dir, env.build)], { inherit: true });
      if (r.status !== 0) failed = true;
    }
  } else if (cmd === "test") {
    const runtime = makeRuntime();
    for (const dir of dirs) {
      const b = loadOrDie(dir);
      const lint = lintBundle(b).filter((i) => i.level === "error");
      if (lint.length) {
        console.log(`✗ ${b.meta.slug}: lint errors, run 'wom scenario lint' first`);
        failed = true;
        continue;
      }
      console.log(`== test ${b.meta.slug}`);
      const report = await runScenarioTest(runtime, b, { keep: flags.has("--keep"), timeoutMs, log: (l) => console.log("  " + l) });
      console.log(`${report.ok ? "✓" : "✗"} ${b.meta.slug}: create ${report.timings.createMs} ms, break ${report.timings.breakMs} ms`);
      if (!report.ok) failed = true;
    }
  } else if (cmd === "run") {
    const b = loadOrDie(dirs[0]);
    const env = b.meta.environment;
    if (!env) throw new Error("text-only scenario: nothing to run");
    const runtime = makeRuntime();
    const handle = await runtime.create(specFromEnvironment(publicEnvironment(env, dirs[0]), `run-${b.meta.slug}-${Date.now()}`, { "wom.owner": "cli", "wom.test": "run" }));
    console.log(`== sandbox ${handle.containerId.slice(0, 12)} created`);
    const cleanup = async () => {
      await runtime.destroy(handle).catch(() => {});
      console.log("== sandbox destroyed");
    };
    try {
      await new Promise((r) => setTimeout(r, 1500));
      if (b.scripts.break) {
        const r = await runtime.runScript(handle, b.scripts.break, { user: "root", timeoutMs });
        console.log(`== break: exit ${r.exitCode} ${r.stdout.trim().split("\n").pop() ?? ""}`);
      }
      if (flags.has("--solve") && b.scripts.solve) {
        const r = await runtime.runScript(handle, b.scripts.solve, { user: "root", timeoutMs });
        console.log(`== solve: exit ${r.exitCode}`);
      }
      const sh = shellFromEnvironment(publicEnvironment(env, dirs[0]));
      console.log(`== shell as ${sh.user} (type 'exit' to finish; the grader runs on exit)`);
      docker(["exec", "-it", "-u", sh.user, "-w", sh.cwd, "-e", "TERM=xterm-256color", handle.containerId, sh.shell, "-l"], { inherit: true });
      if (b.scripts.check) {
        const r = await runtime.runScript(handle, b.scripts.check, { user: "root", timeoutMs });
        console.log(`== grader: ${r.stdout.trim()}`);
      }
    } finally {
      await cleanup();
    }
  } else if (cmd === "push") {
    if (dirs.length !== 1) throw new Error("push takes exactly one scenario folder");
    const user = process.env.WOM_USER ?? "";
    const password = process.env.WOM_PASSWORD ?? "";
    if (!pushUrl) throw new Error("push needs the platform address: --url https://host or WOM_URL");
    if (!user || !password) throw new Error("push needs WOM_USER and WOM_PASSWORD in the environment (the account on the platform; they are not accepted as arguments)");
    const b = loadOrDie(dirs[0]);
    const errors = lintBundle(b).filter((i) => i.level === "error");
    if (errors.length) {
      for (const i of errors) console.log(`  ✗ [${i.rule}] ${i.message}`);
      throw new Error(`${b.meta.slug}: lint errors, fix them before push`);
    }
    const r = await pushScenario({
      url: pushUrl,
      user,
      password,
      zip: packScenarioDir(dirs[0]),
      check: flags.has("--check"),
      publish: flags.has("--publish"),
      start: flags.has("--start"),
      waitSec,
      log: (l) => console.log(l),
    });
    console.log(`${r.ok ? "✓" : "✗"} ${r.slug}: ${r.next}`);
    if (r.sessionUrl) console.log(`SESSION_URL=${r.sessionUrl}`);
    if (r.scenarioUrl && r.ok && r.status === "APPROVED") console.log(`SCENARIO_URL=${r.scenarioUrl}`);
    if (r.needsAdmin) process.exit(3);
    if (!r.ok) failed = true;
  } else if (cmd === "export") {
    if (!outFile) throw new Error("export needs -o <file>");
    const scenarios = dirs.map((d) => toImportRecord(loadOrDie(d)));
    writeFileSync(outFile, JSON.stringify({ version: 2, scenarios }, null, 2) + "\n");
    console.log(`✓ wrote ${scenarios.length} scenario(s) to ${outFile}`);
  } else {
    console.error(`unknown command: ${cmd}\n` + usage);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

main(process.argv.slice(2)).catch((e) => {
  const err = e as NodeJS.ErrnoException;
  // dockerode surfaces a missing or refused daemon as a bare socket error
  if (err.syscall === "connect" && (err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "EACCES")) {
    console.error(`✗ cannot reach the docker daemon at ${process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock"} (${err.code}): is it running, and is DOCKER_HOST set to the sandbox daemon?`);
  } else console.error(`✗ ${err.message}`);
  process.exit(1);
});
