import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@wom/db";
import { requireAdminPage } from "@/lib/admin";
import { formatDateTime } from "@/lib/format";
import { AdminAction, ResetPassword } from "@/components/admin-actions";
import { ShowMore, parseLimit } from "@/components/show-more";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Пользователи · админка" };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; disabled?: string; limit?: string }> }) {
  const me = await requireAdminPage();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 64);
  const onlyDisabled = sp.disabled === "1";
  const limit = parseLimit(sp.limit, 100);
  const rows = await prisma.user.findMany({
    where: {
      ...(q ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
      ...(onlyDisabled ? { disabledAt: { not: null } } : {}),
    },
    orderBy: [{ role: "asc" }, { createdAt: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      createdAt: true,
      lastLoginAt: true,
      disabledAt: true,
      _count: { select: { trainingSessions: true, submissions: true } },
    },
  });
  const users = rows.slice(0, limit);
  const solved = await prisma.trainingSession.groupBy({ by: ["userId"], where: { status: "FINISHED", userId: { in: users.map((u) => u.id) } }, _count: { _all: true } });
  const solvedBy = new Map(solved.map((s) => [s.userId, s._count._all]));

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Пользователи</h1>
      <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>
        Активность — любой запрос под учёткой. Неактивные {process.env.INACTIVE_ACCOUNT_DAYS ?? 7} дней отключаются автоматически; здесь их можно включить обратно.
      </p>
      <form method="get" className="mb-4 flex flex-wrap items-center gap-3 text-sm" data-testid="users-filter">
        <input
          name="q"
          defaultValue={q}
          placeholder="Поиск по логину или почте"
          aria-label="Поиск по логину или почте"
          maxLength={64}
          className="input w-64 py-1.5"
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" name="disabled" value="1" defaultChecked={onlyDisabled} />
          только отключённые
        </label>
        <button className="btn px-3 py-1.5 text-sm" type="submit">
          Найти
        </button>
        {(q || onlyDisabled) && (
          <Link href="/admin/users" className="text-sm">
            Сбросить
          </Link>
        )}
      </form>
      <div className="overflow-x-auto">
        <table className="table">
          <caption className="sr-only">Пользователи платформы</caption>
          <thead>
            <tr>
              <th scope="col">Логин</th>
              <th scope="col">Роль</th>
              <th scope="col">Создан</th>
              <th scope="col">Активность</th>
              <th scope="col">Сессий / решено</th>
              <th scope="col">Заявок</th>
              <th scope="col">Статус</th>
              <th scope="col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} data-testid={`user-${u.username}`}>
                <td>
                  <div className="font-medium">
                    {u.username}
                    {u.id === me.id && (
                      <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                        (ты)
                      </span>
                    )}
                  </div>
                  {u.email && (
                    <div className="text-xs" style={{ color: "var(--muted)" }}>
                      {u.email}
                    </div>
                  )}
                </td>
                <td>{u.role === "admin" ? "админ" : "пользователь"}</td>
                <td className="whitespace-nowrap">{formatDateTime(u.createdAt)}</td>
                <td className="whitespace-nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</td>
                <td className="tabular-nums">
                  {u._count.trainingSessions} / {solvedBy.get(u.id) ?? 0}
                </td>
                <td className="tabular-nums">{u._count.submissions}</td>
                <td className="whitespace-nowrap">
                  {u.disabledAt ? <span style={{ color: "var(--bad)" }}>отключён {formatDateTime(u.disabledAt)}</span> : <span style={{ color: "var(--ok)" }}>активен</span>}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {u.disabledAt ? (
                      <AdminAction url={`/api/admin/users/${u.id}/enable`} label="Включить" primary testId="user-enable" />
                    ) : (
                      u.id !== me.id && <AdminAction url={`/api/admin/users/${u.id}/disable`} label="Отключить" confirm={`Отключить ${u.username}? Его текущие входы завершатся.`} testId="user-disable" />
                    )}
                    {u.role === "admin" ? (
                      u.id !== me.id && <AdminAction url={`/api/admin/users/${u.id}/make-user`} label="Снять админа" confirm={`Снять роль администратора с ${u.username}?`} />
                    ) : (
                      <AdminAction url={`/api/admin/users/${u.id}/make-admin`} label="Сделать админом" confirm={`Сделать ${u.username} администратором?`} />
                    )}
                    <ResetPassword userId={u.id} username={u.username} />
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: "var(--muted)" }}>
                  Никого не нашли.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ShowMore limit={limit} hasMore={rows.length > limit} extra={{ ...(q ? { q } : {}), ...(onlyDisabled ? { disabled: "1" } : {}) }} />
    </div>
  );
}
