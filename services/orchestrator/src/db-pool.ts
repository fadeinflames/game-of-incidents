// Prisma sizes its connection pool from DATABASE_URL, not from a setting of its own. Without `connection_limit` it opens
// num_cpus * 2 + 1 connections per process, and the web app and the orchestrator share one PostgreSQL (max_connections
// 100 by default) with the nightly dump on top. The pool is set where the URL is built: docker-compose.yml passes
// `connection_limit=${DB_POOL_LIMIT:-10}&pool_timeout=${DB_POOL_TIMEOUT_SEC:-20}` to both services. This file only reads
// the URL back, so a start with an unbounded pool is visible in the log instead of showing up later as "too many clients".

export type DatabasePool = { connectionLimit: number | null; poolTimeoutSec: number | null };

function intParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** the pool parameters of a DATABASE_URL; null = not set (or not a number), i.e. Prisma's default applies. Never returns the URL itself: it carries the password. */
export function databasePool(url: string | undefined): DatabasePool {
  if (!url) return { connectionLimit: null, poolTimeoutSec: null };
  const q = url.indexOf("?");
  const params = new URLSearchParams(q < 0 ? "" : url.slice(q + 1));
  return { connectionLimit: intParam(params, "connection_limit"), poolTimeoutSec: intParam(params, "pool_timeout") };
}
