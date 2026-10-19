function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

/** A typo like "2O" or "5m" must stop the start: NaN would silently turn quotas off and timeouts into zero. */
export function parseNum(name: string, raw: string | undefined, dflt: number): number {
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid env ${name}="${raw}": a non-negative number is expected`);
  return n;
}

function num(name: string, dflt: number): number {
  return parseNum(name, process.env[name], dflt);
}

export const config = {
  port: num("PORT", 8080),
  internalToken: required("INTERNAL_TOKEN"),
  dockerSocket: process.env.DOCKER_SOCKET ?? (process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock").replace(/^unix:\/\//, ""),
  maxSessionsPerUser: num("MAX_SESSIONS_PER_USER", 1),
  maxSessionsGlobal: num("MAX_SESSIONS_GLOBAL", 10),
  /** active sessions requested from one client address, across accounts (0 = no limit) */
  maxSessionsPerIp: num("MAX_SESSIONS_PER_IP", 3),
  /** kubernetes sessions are ~10x heavier (ADR-0008): separate cap */
  maxK8sSessions: num("MAX_K8S_SESSIONS", 3),
  /** clusters being created at the same time, 2 by default; the rest wait in REQUESTED (a kind create is CPU-bound: 6 at once took 4.5 min each on prod) */
  maxK8sProvisioning: num("MAX_K8S_PROVISIONING", 2),
  /** how long a session may wait for a provisioning slot before the reconciler gives up on it */
  queueTimeoutMs: num("QUEUE_TIMEOUT_MS", 20 * 60_000),
  /** path to the kind binary; empty string disables the kubernetes runtime */
  kindBin: process.env.KIND_BIN ?? "kind",
  toolsImage: process.env.TOOLS_IMAGE ?? "wom-tools:dev",
  reconcileIntervalMs: num("RECONCILE_INTERVAL_MS", 30_000),
  /** /health reports ok:false when the reconciler has not finished a pass for this many intervals */
  healthReconcilerStaleIntervals: num("HEALTH_RECONCILER_STALE_INTERVALS", 5),
  /** /health reports ok:false when more sessions than this ended FAILED in the last hour */
  failedAlertPerHour: num("FAILED_ALERT_PER_HOUR", 5),
  terminalTokenTtlMs: num("TERMINAL_TOKEN_TTL_MS", 60_000),
  // kubernetes graders probe through kubectl exec and may wait for rollouts: minutes, not seconds
  graderTimeoutMs: num("GRADER_TIMEOUT_MS", 240_000),
  breakTimeoutMs: num("BREAK_TIMEOUT_MS", 240_000),
  // a kind cluster + image loading + manifests + break can take ~90 s on the dev host (owner: up to a minute is fine)
  provisioningTimeoutMs: num("PROVISIONING_TIMEOUT_MS", 300_000),
  defaultTtlMin: num("DEFAULT_TTL_MIN", 45),
  /** accounts without any activity for this many days are disabled (0 = never); owner: 7 days */
  inactiveAccountDays: num("INACTIVE_ACCOUNT_DAYS", 7),
  /** file the egress guard rewrites with `date +%s` after every successful rule check; empty = the check is off */
  egressHeartbeatFile: process.env.EGRESS_HEARTBEAT_FILE ?? "",
  egressHeartbeatMaxAgeSec: num("EGRESS_HEARTBEAT_MAX_AGE_SEC", 150),
  /** filesystem whose fill level gates new sessions; the container root sits on the sandbox daemon's data-root */
  diskGuardPath: process.env.DISK_GUARD_PATH || "/",
  /** used space, percent: from here on no new sessions are accepted */
  diskRefusePct: num("DISK_REFUSE_PCT", 85),
  /** used space, percent: from here on the reconciler stops every active session to free the disk */
  diskKillPct: num("DISK_KILL_PCT", 93),
  submissionBuildTimeoutMs: num("SUBMISSION_BUILD_TIMEOUT_MS", 10 * 60_000),
  /** a moderator's test run that takes longer than this in total is abandoned and marked FAILED */
  submissionMaxRunMs: num("SUBMISSION_MAX_RUN_MS", 45 * 60_000),
  /** the disk is measured this often between reconciler passes; over diskKillPct the heaviest session is stopped, then the disk is looked at again */
  diskCheckIntervalMs: num("DISK_CHECK_INTERVAL_MS", 5_000),
  /** SessionEvent rows older than this many days are deleted, daily, in batches (0 = keep forever) */
  retentionDays: num("RETENTION_DAYS", 90),
  /** archives (zip) of published or rejected submissions older than this many days are emptied, daily, in batches (0 = keep forever) */
  retentionArchiveDays: num("RETENTION_ARCHIVE_DAYS", 180),
  // The size of the Prisma connection pool is not a setting here: it comes from DATABASE_URL (connection_limit, pool_timeout),
  // which docker-compose.yml builds from DB_POOL_LIMIT and DB_POOL_TIMEOUT_SEC. See db-pool.ts.
};

export type Config = typeof config;

/** the effective settings for the startup log, without the secret */
export function loggableConfig(): Omit<Config, "internalToken"> {
  const { internalToken: _secret, ...rest } = config;
  return rest;
}
