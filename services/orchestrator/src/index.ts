import { prisma } from "@wom/db";
import { DockerRuntimeProvider, KubernetesRuntimeProvider, RuntimeRegistry } from "@wom/runtime";
import { config, loggableConfig } from "./config";
import { databasePool } from "./db-pool";
import { diskUsedPct, egressState } from "./guards";
import { createHealthProbe } from "./health";
import { IpLimitMonitor } from "./ip-limits";
import { logger } from "./logger";
import { installFatalHandlers } from "./process-guards";
import { Reconciler } from "./reconciler";
import { createServer } from "./server";
import { ACTIVE_STATUSES, SessionService } from "./sessions";
import { TerminalTokenStore } from "./terminal-tokens";
import { AccountJanitor } from "./accounts";
import { startRetention } from "./retention";
import { SubmissionRunner } from "./submissions";

async function main() {
  logger.info({ config: loggableConfig() }, "effective configuration");
  const docker = new DockerRuntimeProvider(config.dockerSocket);
  await docker.ping();
  await prisma.$queryRaw`SELECT 1`;
  const pool = databasePool(process.env.DATABASE_URL);
  if (pool.connectionLimit === null) {
    logger.warn({}, "DATABASE_URL has no connection_limit: Prisma opens num_cpus*2+1 connections, shared with the web app on one PostgreSQL (docker-compose sets it from DB_POOL_LIMIT)");
  } else {
    logger.info({ ...pool }, "database connection pool");
  }

  // The provider stays registered when kind does not answer at start: the registry marks kubernetes unavailable, refuses
  // new kubernetes stands, shows it in /health and re-probes on every reconciler pass. Dropping the provider altogether
  // (the old behaviour) made the reconciler read every running kubernetes session as vanished and leave its cluster behind.
  const kubernetes = config.kindBin ? new KubernetesRuntimeProvider(docker, { kindBin: config.kindBin, toolsImage: config.toolsImage }) : undefined;
  const runtime = new RuntimeRegistry({ docker, kubernetes });
  if (kubernetes) {
    const state = await runtime.probeKubernetes({ attempts: 4, delayMs: 2000 });
    if (state === "ready") logger.info({ kindBin: config.kindBin, toolsImage: config.toolsImage }, "kubernetes runtime enabled (ADR-0008)");
    else logger.error({ kindBin: config.kindBin }, "kind does not answer after several attempts: kubernetes stands are refused until it does (checked again on every reconcile pass)");
  } else {
    logger.info({}, "kubernetes runtime disabled (KIND_BIN is empty)");
  }
  void docker
    .defaultAddressPools()
    .then((pools) => {
      if (!pools.length) {
        logger.warn(
          {},
          "docker daemon has no default-address-pools: the built-in ranges hold about 30 networks, one per session and cluster; add default-address-pools to daemon.json (see the runbook)",
        );
      }
    })
    .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "docker address pools could not be read"));
  const usedDiskPct = () => diskUsedPct(config.diskGuardPath);
  const egress = () => egressState(config.egressHeartbeatFile, config.egressHeartbeatMaxAgeSec);

  const sessions = new SessionService(prisma, runtime, {
    maxSessionsPerUser: config.maxSessionsPerUser,
    maxSessionsGlobal: config.maxSessionsGlobal,
    maxK8sSessions: config.maxK8sSessions,
    maxK8sProvisioning: config.maxK8sProvisioning,
    breakTimeoutMs: config.breakTimeoutMs,
    graderTimeoutMs: config.graderTimeoutMs,
    defaultTtlMin: config.defaultTtlMin,
    maxSessionsPerIp: config.maxSessionsPerIp,
    diskUsedPct: usedDiskPct,
    diskRefusePct: config.diskRefusePct,
    egressState: egress,
  });
  const tokens = new TerminalTokenStore(config.terminalTokenTtlMs);
  const reconciler = new Reconciler(prisma, runtime, sessions, {
    provisioningTimeoutMs: config.provisioningTimeoutMs,
    queueTimeoutMs: config.queueTimeoutMs,
    intervalMs: config.reconcileIntervalMs,
    graderTimeoutMs: config.graderTimeoutMs,
    diskUsedPct: usedDiskPct,
    diskKillPct: config.diskKillPct,
    diskCheckEveryMs: config.diskCheckIntervalMs,
  });

  // a test run goes through the same host checks and provisioning slots as a player's session
  const submissions = new SubmissionRunner(prisma, runtime, {
    dockerSocket: config.dockerSocket,
    host: sessions,
    buildTimeoutMs: config.submissionBuildTimeoutMs,
    maxRunMs: config.submissionMaxRunMs,
  });
  // the moderator asked for these tests, and the queue lived in the process that died: put them back in the new one
  const stale = await submissions.resetStale();
  if (stale.length) {
    logger.info({ stale: stale.length }, "submissions left in TESTING by a previous run are queued again");
    for (const id of stale) submissions.enqueue(id);
  }
  // a test left in TESTING that no run owns (a crash between two writes) would otherwise stay there for good
  setInterval(() => {
    submissions.failStuck().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "stuck submission sweep failed"));
  }, 60_000).unref();
  const stopRetention = startRetention(
    prisma,
    { events: config.retentionDays, archives: config.retentionArchiveDays },
    { dockerUsage: () => docker.diskUsage() },
  );

  // before the recovery below starts provisioning again: a network that is still waiting for its first container looks orphaned
  await docker.removeOrphanNetworks();

  // nothing is listening yet, so every REQUESTED/PROVISIONING/CHECKING row here was left behind by the previous process
  const recovered = await sessions.recoverAfterRestart();
  if (recovered.failed || recovered.requeued || recovered.checks) logger.info({ ...recovered }, "sessions recovered after a restart");

  const server = createServer({
    sessions,
    tokens,
    reconciler,
    submissions,
    ipLimits: new IpLimitMonitor(),
    internalToken: config.internalToken,
    activeSessionCount: () => prisma.trainingSession.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    diskUsedPct: usedDiskPct,
    egressState: egress,
    health: createHealthProbe({
      prisma,
      pingDocker: () => docker.ping(),
      lastReconcileAt: () => reconciler.lastRunAt,
      kubernetesState: () => runtime.kubernetesState(),
      thresholds: {
        reconcilerStaleSec: (config.reconcileIntervalMs * config.healthReconcilerStaleIntervals) / 1000,
        failedPerHour: config.failedAlertPerHour,
      },
    }),
  });

  reconciler.start();
  const janitor = new AccountJanitor(prisma, { inactiveDays: config.inactiveAccountDays });
  janitor.start();
  server.listen(config.port, "0.0.0.0", () => logger.info({ port: config.port, socket: config.dockerSocket }, "orchestrator listening"));

  // Sandboxes deliberately survive an orchestrator restart (live sessions keep running; the reconciler re-adopts them).
  // the sandboxes being destroyed in the background get a moment to finish; whatever is left is an orphan for the next process
  const stopServing = () => {
    sessions.setDraining(true);
    reconciler.stop();
    janitor.stop();
    stopRetention();
    return Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), sessions.settleDestroys(2500)]).then(() => undefined);
  };
  const shutdown = () => {
    logger.info({}, "shutting down");
    void stopServing().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  onFatal = stopServing;
}

/** set once the server runs; before that there is nothing to stop and the process just leaves */
let onFatal: (() => Promise<void>) | undefined;
installFatalHandlers({ proc: process, log: (fields, msg) => logger.error(fields, msg), cleanup: () => onFatal?.() });

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
