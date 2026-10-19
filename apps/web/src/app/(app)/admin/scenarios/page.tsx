import type { Metadata } from "next";
import { prisma } from "@wom/db";
import { requireAdminPage } from "@/lib/admin";
import { formatDateTime } from "@/lib/format";
import { DIFFICULTY } from "@/lib/labels";
import { AdminAction } from "@/components/admin-actions";
import { parseEnvironment } from "../../scenario-json";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Сценарии · админка" };

export default async function AdminScenariosPage() {
  await requireAdminPage();
  const scenarios = await prisma.scenario.findMany({
    orderBy: [{ isPublished: "desc" }, { slug: "asc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      difficulty: true,
      tags: true,
      isPublished: true,
      environmentJson: true,
      updatedAt: true,
      author: { select: { username: true } },
      _count: { select: { trainingSessions: true } },
    },
  });
  const solved = await prisma.trainingSession.groupBy({ by: ["scenarioId"], where: { status: "FINISHED" }, _count: { _all: true } });
  const solvedBy = new Map(solved.map((s) => [s.scenarioId, s._count._all]));

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Сценарии</h1>
      <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>
        Снятый с публикации сценарий пропадает из каталога, история сессий по нему остаётся. Учебная копия следует за обычной.
      </p>
      <div className="overflow-x-auto">
        <table className="table">
          <caption className="sr-only">Сценарии платформы</caption>
          <thead>
            <tr>
              <th scope="col">Сценарий</th>
              <th scope="col">Уровень</th>
              <th scope="col">Окружение</th>
              <th scope="col">Автор</th>
              <th scope="col">Сессий / решено</th>
              <th scope="col">Обновлён</th>
              <th scope="col">Статус</th>
              <th scope="col">
                <span className="sr-only">Действия</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => {
              const env = parseEnvironment(s.environmentJson);
              const kind = env ? (env.kind === "kubernetes" ? "Kubernetes" : "Linux‑хост") : "текст";
              return (
                <tr key={s.id} data-testid={`admin-scenario-${s.slug}`}>
                  <td>
                    <div className="font-medium">{s.title}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>
                      {s.slug}
                      {s.tags.includes("tutorial") && " · 🎓"}
                    </div>
                  </td>
                  <td>{DIFFICULTY[s.difficulty]}</td>
                  <td>{kind}</td>
                  <td>{s.author?.username ?? "платформа"}</td>
                  <td className="tabular-nums">
                    {s._count.trainingSessions} / {solvedBy.get(s.id) ?? 0}
                  </td>
                  <td className="whitespace-nowrap">{formatDateTime(s.updatedAt)}</td>
                  <td className="whitespace-nowrap">{s.isPublished ? <span style={{ color: "var(--ok)" }}>в каталоге</span> : <span style={{ color: "var(--muted)" }}>скрыт</span>}</td>
                  <td>
                    {s.isPublished ? (
                      <AdminAction url={`/api/admin/scenarios/${s.id}/unpublish`} label="Скрыть" confirm={`Убрать «${s.title}» из каталога?`} testId="scenario-unpublish" />
                    ) : (
                      <AdminAction url={`/api/admin/scenarios/${s.id}/publish`} label="Опубликовать" primary testId="scenario-publish" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
