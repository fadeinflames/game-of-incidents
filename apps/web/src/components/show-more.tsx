// "Show more" paging for the server-rendered lists: the page reads ?limit=, fetches one row more than it shows and
// links to a larger limit. No state on the client, the URL is the cursor.
import Link from "next/link";

export const PAGE_SIZE = 50;
const MAX_LIMIT = 1000;

/** ?limit= as a number: at least the base page, at most MAX_LIMIT */
export function parseLimit(raw: string | string[] | undefined, base = PAGE_SIZE): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > base ? Math.min(n, MAX_LIMIT) : base;
}

/** `extra` carries the other query parameters (search, filter) so they survive the click */
export function ShowMore({ limit, hasMore, extra = {} }: { limit: number; hasMore: boolean; extra?: Record<string, string> }) {
  if (!hasMore) return null;
  if (limit >= MAX_LIMIT) {
    return (
      <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
        Показаны первые {MAX_LIMIT}. Уточни поиск, чтобы увидеть остальные.
      </p>
    );
  }
  const query = new URLSearchParams({ ...extra, limit: String(Math.min(limit + PAGE_SIZE, MAX_LIMIT)) });
  return (
    <div className="mt-3">
      <Link href={`?${query}`} className="btn no-underline" data-testid="show-more">
        Показать ещё
      </Link>
    </div>
  );
}
