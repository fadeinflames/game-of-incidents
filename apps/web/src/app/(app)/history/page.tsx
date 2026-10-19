import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@wom/db";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { isFinalSessionStatus, SESSION_STATUS } from "@/lib/labels";
import { Badge, SESSION_TONE } from "@/components/badge";
import { ShowMore, parseLimit } from "@/components/show-more";

function duration(a: Date | null, b: Date | null) {
  if (!a || !b) return "—";
  const s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

export const metadata: Metadata = { title: "История" };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  const user = await requireUser();
  const limit = parseLimit((await searchParams).limit, 100);
  const rows = await prisma.trainingSession.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    // explicit fields: a whole row carries the runtime handle (kubeconfig) of the stand
    select: {
      id: true,
      status: true,
      createdAt: true,
      readyAt: true,
      finishedAt: true,
      hintsUsed: true,
      checkAttempts: true,
      score: true,
      scenario: { select: { title: true, slug: true, isPublished: true } },
    },
  });
  const sessions = rows.slice(0, limit);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">История</h1>
      {sessions.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>Пока пусто. Запусти первый сценарий.</p>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Твои сессии, новые сверху</caption>
            <thead>
              <tr>
                <th scope="col">Дата</th>
                <th scope="col">Сценарий</th>
                <th scope="col">Статус</th>
                <th scope="col">Время</th>
                <th scope="col">Подсказки</th>
                <th scope="col">Проверок</th>
                <th scope="col">Баллы</th>
                <th scope="col">
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap">{formatDateTime(s.createdAt)}</td>
                  <td>
                    <Link href={`/sessions/${s.id}`}>{s.scenario.title}</Link>
                  </td>
                  <td>
                    <Badge tone={SESSION_TONE[s.status]}>{SESSION_STATUS[s.status]}</Badge>
                  </td>
                  <td className="whitespace-nowrap">{duration(s.readyAt, s.finishedAt)}</td>
                  <td>{s.hintsUsed.length}</td>
                  <td>{s.checkAttempts}</td>
                  <td>{s.score ?? "—"}</td>
                  <td className="whitespace-nowrap">
                    {s.scenario.isPublished && isFinalSessionStatus(s.status) && (
                      <Link href={`/scenarios/${s.scenario.slug}`} data-testid="history-retry">
                        Повторить
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ShowMore limit={limit} hasMore={rows.length > limit} />
    </div>
  );
}
