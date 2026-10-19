import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@wom/db";
import { ACTIVE_SESSION_STATUSES, requireAdminPage } from "@/lib/admin";
import { formatDateTime } from "@/lib/format";
import { fmtSeconds, SESSION_STATUS } from "@/lib/labels";
import { AdminAction } from "@/components/admin-actions";
import { Badge, SESSION_TONE } from "@/components/badge";
import { KillAllSessions } from "@/components/kill-all-sessions";
import { ShowMore, parseLimit } from "@/components/show-more";

export const dynamic = "force-dynamic";

const select = {
  id: true,
  status: true,
  provider: true,
  createdAt: true,
  readyAt: true,
  expiresAt: true,
  finishedAt: true,
  startupMs: true,
  startupPhase: true,
  score: true,
  checkAttempts: true,
  hintsUsed: true,
  lastError: true,
  user: { select: { username: true } },
  scenario: { select: { title: true, slug: true } },
} as const;

export const metadata: Metadata = { title: "Сессии · админка" };

export default async function AdminSessionsPage({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  await requireAdminPage();
  const limit = parseLimit((await searchParams).limit);
  const [active, recentPlusOne] = await Promise.all([
    prisma.trainingSession.findMany({ where: { status: { in: [...ACTIVE_SESSION_STATUSES] } }, orderBy: { createdAt: "asc" }, select }),
    prisma.trainingSession.findMany({ where: { status: { notIn: [...ACTIVE_SESSION_STATUSES] } }, orderBy: { createdAt: "desc" }, take: limit + 1, select }),
  ]);
  const recent = recentPlusOne.slice(0, limit);

  const Row = ({ s, live }: { s: (typeof active)[number]; live: boolean }) => (
    <tr data-testid={`session-${s.id}`}>
      <td>
        <Link href={`/sessions/${s.id}`}>{s.scenario.title}</Link>
        <div className="text-xs" style={{ color: "var(--muted)" }}>
          {s.provider === "kubernetes" ? "Kubernetes" : "Linux‑хост"}
        </div>
      </td>
      <td>{s.user.username}</td>
      <td className="whitespace-nowrap">
        <Badge tone={SESSION_TONE[s.status]}>{SESSION_STATUS[s.status]}</Badge>
        {live && s.startupPhase && s.status !== "RUNNING" && (
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            {s.startupPhase}
          </div>
        )}
        {s.status === "FAILED" && s.lastError && (
          <div className="max-w-[320px] text-xs" style={{ color: "var(--bad)" }}>
            {s.lastError.slice(0, 200)}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap">{formatDateTime(s.createdAt)}</td>
      <td className="whitespace-nowrap">{live ? (s.expiresAt ? formatDateTime(s.expiresAt) : "—") : s.finishedAt ? formatDateTime(s.finishedAt) : "—"}</td>
      <td className="tabular-nums">{fmtSeconds(s.startupMs)}</td>
      <td className="tabular-nums">
        {s.score ?? "—"} · {s.checkAttempts} · {s.hintsUsed.length}
      </td>
      <td>
        {live && <AdminAction url={`/api/admin/sessions/${s.id}/kill`} label="Остановить" confirm={`Остановить сессию ${s.user.username} / ${s.scenario.title}? Стенд будет удалён.`} testId="session-kill" />}
      </td>
    </tr>
  );

  const Table = ({ rows, live }: { rows: typeof active; live: boolean }) => (
    <div className="overflow-x-auto">
      <table className="table">
        <caption className="sr-only">{live ? "Активные сессии" : "Завершённые сессии"}</caption>
        <thead>
          <tr>
            <th scope="col">Сценарий</th>
            <th scope="col">Кто</th>
            <th scope="col">Статус</th>
            <th scope="col">Начата</th>
            <th scope="col">{live ? "Удалится" : "Завершена"}</th>
            <th scope="col">Старт</th>
            <th scope="col" title="баллы · попыток проверки · подсказок">
              Баллы · проверок · подсказок
            </th>
            <th scope="col">
              <span className="sr-only">Действия</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <Row key={s.id} s={s} live={live} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} style={{ color: "var(--muted)" }}>
                Пусто.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="mb-1 text-2xl font-bold">Сессии сейчас</h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              «Остановить» удаляет стенд пользователя, сессия помечается как остановленная администратором.
            </p>
          </div>
          <KillAllSessions active={active.length} />
        </div>
        <Table rows={active} live />
      </section>
      <section>
        <h2 className="mb-3 text-xl font-bold">{recentPlusOne.length > limit ? `Завершённые: последние ${limit}` : "Завершённые"}</h2>
        <Table rows={recent} live={false} />
        <ShowMore limit={limit} hasMore={recentPlusOne.length > limit} />
      </section>
    </div>
  );
}
