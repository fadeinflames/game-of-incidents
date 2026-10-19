import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@wom/db";
import { ACTIVE_SESSION_STATUSES, requireAdminPage } from "@/lib/admin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Обзор · админка" };

export default async function AdminOverviewPage() {
  // the layout check is skipped for a client-side navigation request, so every page checks the role itself
  await requireAdminPage();
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  const [users, activeUsers, disabledUsers, admins, activeSessions, sessionsToday, solvedTotal, scenarios, unpublished, pending, testing] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastLoginAt: { gte: weekAgo }, disabledAt: null } }),
    prisma.user.count({ where: { disabledAt: { not: null } } }),
    prisma.user.count({ where: { role: "admin" } }),
    prisma.trainingSession.count({ where: { status: { in: [...ACTIVE_SESSION_STATUSES] } } }),
    prisma.trainingSession.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.trainingSession.count({ where: { status: "FINISHED" } }),
    prisma.scenario.count({ where: { isPublished: true } }),
    prisma.scenario.count({ where: { isPublished: false } }),
    prisma.scenarioSubmission.count({ where: { status: { in: ["UPLOADED", "PASSED"] } } }),
    prisma.scenarioSubmission.count({ where: { status: "TESTING" } }),
  ]);

  const cards = [
    { href: "/admin/users", title: "Пользователи", rows: [[`${users}`, "всего"], [`${activeUsers}`, "активны за 7 дней"], [`${disabledUsers}`, "отключены"], [`${admins}`, "админов"]] },
    { href: "/admin/sessions", title: "Сессии", rows: [[`${activeSessions}`, "идут сейчас"], [`${sessionsToday}`, "за 24 часа"], [`${solvedTotal}`, "решено всего"]] },
    { href: "/admin/scenarios", title: "Сценарии", rows: [[`${scenarios}`, "опубликовано"], [`${unpublished}`, "скрыто"]] },
    { href: "/admin/submissions", title: "Заявки", rows: [[`${pending}`, "ждут модератора"], [`${testing}`, "проверяются"]] },
  ];

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Обзор</h1>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="panel p-5 text-[var(--text)] no-underline">
            <h2 className="mb-3 font-semibold">{c.title}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {c.rows.map(([v, l]) => (
                <div key={l} className="contents">
                  <dt className="text-right text-base font-semibold tabular-nums">{v}</dt>
                  <dd style={{ color: "var(--muted)" }}>{l}</dd>
                </div>
              ))}
            </dl>
          </Link>
        ))}
      </div>
    </div>
  );
}
