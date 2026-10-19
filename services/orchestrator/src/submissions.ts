// Moderation test runs (author cabinet): unzip the submission, build its image(s), run the scenario regression with the
// real runtime, store the report. One at a time; only when a moderator asked (untrusted code never builds on its own).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@wom/db";
import { Prisma, SubmissionStatus } from "@wom/db";

const TESTABLE: SubmissionStatus[] = [SubmissionStatus.UPLOADED, SubmissionStatus.PASSED, SubmissionStatus.FAILED];
import type { RuntimeProvider, SandboxSpec } from "@wom/runtime";
import { extractScenarioZip, lintBundle, loadScenarioFolder, runScenarioTest, toImportRecord, type ScenarioBundle } from "@wom/scenario";
import { logger } from "./logger";

const BUILD_LOG_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 10_000;

/**
 * Runs a command with a hard time limit, keeping only the tail of its output: the Dockerfile being built is someone
 * else's, and neither a build that never ends nor one that prints without end may hold the queue or grow the heap.
 */
export function runWithLogTail(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; tailBytes: number },
): Promise<{ code: number | null; timedOut: boolean; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let tail: Buffer = Buffer.alloc(0);
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > opts.tailBytes) tail = tail.subarray(tail.length - opts.tailBytes);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, opts.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(hardKill);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      resolve({ code, timedOut, log: tail.toString("utf8") });
    });
  });
}

/**
 * The test report is read by the author: the build log stays (it is how a Dockerfile gets fixed), but the paths of the
 * host it ran on do not.
 */
export function scrubHostPaths(text: string): string {
  return text
    .replace(/unix:\/\/\S+/g, "unix://<docker>")
    .replace(/\/(?:tmp|var\/tmp)\/wom-sub-[A-Za-z0-9]+/g, "<build>")
    .replace(new RegExp(`${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]wom-sub-[A-Za-z0-9]+`, "g"), "<build>")
    .replace(/\/(?:run\/user|srv)\/[^\s'":]+/g, "<host-path>");
}

/** the tag a scenario folder's Dockerfile is built under (kubernetes scenarios build the first of their images); null = nothing is built */
export function builtImageTag(env: NonNullable<ScenarioBundle["meta"]["environment"]>): string | null {
  if (!env.build) return null;
  return env.kind === "kubernetes" ? (env.images[0] ?? env.image) : env.image;
}

/** Where a submission's image lives. The tag in the archive is the author's choice and may be the tag a published
 *  scenario runs on: building under it would swap that scenario's image before anyone approved anything. */
export function submissionImageTag(slug: string, submissionId: string): string {
  return `wom-scenario/${slug}:sub-${submissionId}`;
}

/**
 * Rewrites the built image's tag to `newTag` in scenario.yaml and in the files that name it (manifests, scripts) and
 * loads the folder again, so the build, the regression run and the record that gets published all use the same tag.
 */
export function retagScenarioFolder(bundle: ScenarioBundle, newTag: string): ScenarioBundle {
  const env = bundle.meta.environment;
  const oldTag = env ? builtImageTag(env) : null;
  if (!env || !oldTag || oldTag === newTag) return bundle;
  const root = path.resolve(bundle.dir);
  const inside = (f: string) => f.startsWith(root + path.sep);
  const files = [path.join(root, "scenario.yaml")];
  for (const rel of [env.setup, env.break, env.check, env.solve]) if (rel) files.push(path.resolve(root, rel));
  if (env.manifests) {
    const mdir = path.resolve(root, env.manifests);
    if (inside(mdir + path.sep) && existsSync(mdir)) for (const f of readdirSync(mdir)) if (/\.ya?ml$/.test(f)) files.push(path.join(mdir, f));
  }
  // not followed by a tag character, so ":sub-1" does not eat the tail of ":sub-10"
  const re = new RegExp(`${oldTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.-])`, "g");
  for (const f of files) {
    if (!inside(f) || !existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    const next = text.replace(re, newTag);
    if (next !== text) writeFileSync(f, next);
  }
  return loadScenarioFolder(bundle.dir);
}

/** what a test run needs from the platform: the same host checks and provisioning slots a player's session goes through */
export interface SubmissionHost {
  assertHostReady(provider: "docker" | "kubernetes"): Promise<void>;
  withProvisioningSlot<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export type SubmissionRunnerOptions = {
  dockerSocket: string;
  host: SubmissionHost;
  buildTimeoutMs?: number;
  testTimeoutMs?: number;
  /** a run that takes longer than this in total is abandoned and marked FAILED, so the queue never hangs on it (default 45 min) */
  maxRunMs?: number;
};

const DEFAULT_MAX_RUN_MS = 45 * 60_000;
/** a TESTING row nobody in this process owns is given this long before it is failed (a database blip may be delaying its own write) */
export const STUCK_TESTING_GRACE_MS = 5 * 60_000;

/**
 * The runtime a test run creates stands through. Without it the run would bypass what protects the host from a player's
 * session: the disk threshold, the egress guard and the limit on clusters being created at once (the slot is held while
 * the stand is created, not while the scenario is tested).
 */
export function guardedRuntime(runtime: RuntimeProvider, host: SubmissionHost, key: string): RuntimeProvider {
  let n = 0;
  return {
    async create(spec: SandboxSpec) {
      await host.assertHostReady(spec.kubernetes ? "kubernetes" : "docker");
      if (!spec.kubernetes) return runtime.create(spec);
      return host.withProvisioningSlot(`${key}:${++n}`, () => runtime.create(spec));
    },
    runScript: (h, script, opts) => runtime.runScript(h, script, opts),
    openTerminal: (h, opts) => runtime.openTerminal(h, opts),
    status: (h) => runtime.status(h),
    destroy: (h) => runtime.destroy(h),
    list: () => runtime.list(),
  };
}

export class SubmissionRunner {
  private queue: string[] = [];
  private running = false;
  /** the submission being tested right now */
  private current: string | null = null;

  constructor(
    private prisma: PrismaClient,
    private runtime: RuntimeProvider,
    private opts: SubmissionRunnerOptions,
  ) {}

  /** submissions left in TESTING by a crash go back to the queue's entry state; the ids, so the caller can test them again */
  async resetStale(): Promise<string[]> {
    const stale = await this.prisma.scenarioSubmission.findMany({ where: { status: SubmissionStatus.TESTING }, select: { id: true } });
    const ids = stale.map((s) => s.id);
    if (ids.length) await this.prisma.scenarioSubmission.updateMany({ where: { id: { in: ids }, status: SubmissionStatus.TESTING }, data: { status: SubmissionStatus.UPLOADED } });
    return ids;
  }

  enqueue(id: string): { position: number } {
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.process();
    return { position: this.queue.indexOf(id) + 1 };
  }

  private async process() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        this.current = id;
        await this.runBounded(id).catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err), submissionId: id }, "submission test crashed"));
        this.current = null;
      }
    } finally {
      this.current = null;
      this.running = false;
    }
  }

  /** one run, but never longer than maxRunMs: a stage that hangs for good must not hold the whole queue */
  private async runBounded(id: string): Promise<void> {
    const limit = this.opts.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), limit);
    });
    try {
      const outcome = await Promise.race([this.run(id).then(() => "done" as const), expired]);
      if (outcome === "expired") {
        logger.error({ submissionId: id, limitMs: limit }, "submission test abandoned: it ran past the time limit");
        await this.failTesting(id, `Прогон остановлен: превышен общий лимит времени ${Math.round(limit / 60_000)} мин.`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** TESTING -> FAILED with a note for the author; only a row that is still TESTING is touched (a moderator may have decided it meanwhile) */
  private async failTesting(id: string, error: string): Promise<boolean> {
    const moved = await this.prisma.scenarioSubmission.updateMany({
      where: { id, status: SubmissionStatus.TESTING },
      data: { status: SubmissionStatus.FAILED, testReport: { ok: false, steps: [], error } as Prisma.InputJsonValue },
    });
    return moved.count === 1;
  }

  /**
   * Rows left in TESTING that no run in this process owns (a run that crashed before it could write its verdict, a
   * database blip at the wrong moment) become FAILED, so the moderator sees a result and can run the test again.
   * A row this process is testing or has queued is never touched.
   */
  async failStuck(olderThanMs: number = STUCK_TESTING_GRACE_MS, now: Date = new Date()): Promise<string[]> {
    const rows = await this.prisma.scenarioSubmission.findMany({
      where: { status: SubmissionStatus.TESTING, updatedAt: { lt: new Date(now.getTime() - olderThanMs) } },
      select: { id: true },
    });
    const failed: string[] = [];
    for (const { id } of rows) {
      if (id === this.current || this.queue.includes(id)) continue;
      if (await this.failTesting(id, "Прогон прервался и не записал результат. Запусти проверку ещё раз.")) {
        failed.push(id);
        logger.warn({ submissionId: id }, "submission stuck in TESTING: marked FAILED");
      }
    }
    return failed;
  }

  async run(id: string): Promise<void> {
    const sub = await this.prisma.scenarioSubmission.findUnique({ where: { id } });
    if (!sub) return;
    if (!TESTABLE.includes(sub.status)) return;
    await this.prisma.scenarioSubmission.update({ where: { id }, data: { status: SubmissionStatus.TESTING, testReport: Prisma.JsonNull } });
    logger.info({ submissionId: id, slug: sub.slug }, "submission test started");

    let tmp: string | null = null;
    let report: Record<string, unknown> = { ok: false, steps: [] as unknown[] };
    try {
      // inside the try: a failure here (the disk is full) must end in FAILED, not leave the row in TESTING for good
      tmp = mkdtempSync(path.join(os.tmpdir(), "wom-sub-"));
      const { dir } = extractScenarioZip(new Uint8Array(sub.archive), tmp);
      const declared = loadScenarioFolder(dir);
      const lintErrors = lintBundle(declared).filter((i) => i.level === "error");
      if (lintErrors.length) throw new Error(`lint: ${lintErrors.map((e) => e.message).join("; ")}`);
      if (!declared.meta.environment) throw new Error("текстовый сценарий без окружения: нечего проверять");
      // the image is built under the submission's own tag (the one lint checked is the author's, see submissionImageTag)
      const bundle = retagScenarioFolder(declared, submissionImageTag(declared.meta.slug, id));
      const env = bundle.meta.environment!;
      // the build writes to the same disk as the stands, and a kubernetes stand needs the egress guard alive
      await this.opts.host.assertHostReady(env.kind === "kubernetes" ? "kubernetes" : "docker");

      // build the image on the sandbox daemon
      let buildLog = "";
      if (env.build) {
        const tag = builtImageTag(env)!;
        const ctx = path.join(dir, env.build);
        const timeoutMs = this.opts.buildTimeoutMs ?? 10 * 60_000;
        const r = await runWithLogTail("docker", ["build", "--pull=false", "-t", tag, ctx], {
          env: { ...process.env, DOCKER_HOST: `unix://${this.opts.dockerSocket}` },
          timeoutMs,
          tailBytes: BUILD_LOG_TAIL_BYTES,
        }).catch((err: Error) => {
          throw new Error(`docker build failed: ${scrubHostPaths(err.message)}`);
        });
        if (r.timedOut) {
          const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} мин` : `${Math.round(timeoutMs / 1000)} с`;
          throw new Error(`docker build остановлен: превышен лимит времени ${limit}`);
        }
        if (r.code !== 0) throw new Error(`docker build failed: ${scrubHostPaths(r.log.slice(-1500))}`);
        buildLog = scrubHostPaths(r.log.slice(-3000));
      }

      const t = await runScenarioTest(guardedRuntime(this.runtime, this.opts.host, `submission-${id}`), bundle, { timeoutMs: this.opts.testTimeoutMs, log: (l) => logger.debug({ submissionId: id }, l) });
      report = { ok: t.ok, steps: t.steps, timings: t.timings, build: buildLog };
      // the record stored at upload time is what gets published; keep it in sync with what was tested
      // only while the row is still TESTING: a moderator who decided it meanwhile is not overwritten by a late verdict
      const saved = await this.prisma.scenarioSubmission.updateMany({
        where: { id, status: SubmissionStatus.TESTING },
        data: {
          status: t.ok ? SubmissionStatus.PASSED : SubmissionStatus.FAILED,
          testReport: report as Prisma.InputJsonValue,
          record: toImportRecord(bundle) as unknown as Prisma.InputJsonValue,
        },
      });
      logger.info({ submissionId: id, ok: t.ok, saved: saved.count === 1 }, "submission test finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report = { ...report, ok: false, error: scrubHostPaths(message).slice(0, 2000) };
      await this.prisma.scenarioSubmission.updateMany({
        where: { id, status: SubmissionStatus.TESTING },
        data: { status: SubmissionStatus.FAILED, testReport: report as Prisma.InputJsonValue },
      });
      logger.warn({ submissionId: id, err: message.slice(0, 300) }, "submission test failed");
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// the archive purge lives with the other retention jobs
export { purgeSubmissionArchives } from "./retention";
