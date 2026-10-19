import type { Metadata } from "next";
import { prisma } from "@wom/db";
import { ZIP_MAX_BYTES } from "@wom/scenario";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { SubmissionUpload } from "@/components/submission-upload";
import { ShowMore, parseLimit } from "@/components/show-more";
import { Badge, SUBMISSION_TONE } from "@/components/badge";
import { SubmissionReport, SUBMISSION_STATUS } from "@/components/submission-report";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Автору" };

export default async function AuthorPage({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  const user = await requireUser();
  const limit = parseLimit((await searchParams).limit);
  const rows = await prisma.scenarioSubmission.findMany({
    where: { authorId: user.id },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: { id: true, slug: true, title: true, status: true, lintReport: true, testReport: true, moderatorNote: true, scenarioId: true, createdAt: true },
  });
  const items = rows.slice(0, limit);
  const mine = await prisma.scenario.findMany({ where: { authorId: user.id, isPublished: true }, select: { slug: true, title: true, _count: { select: { trainingSessions: true } } } });

  return (
    <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
      <section className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-bold">Автору: мои сценарии</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Загрузи папку сценария zip‑архивом. Платформа сразу проверит формат, администратор запустит сборку и регресс и опубликует.
          </p>
        </div>
        <SubmissionUpload maxBytes={ZIP_MAX_BYTES} />
        <div className="panel p-4 text-sm">
          <h2 className="mb-2 font-semibold">Как подготовить сценарий</h2>
          <ol className="flex list-decimal flex-col gap-1 pl-5" style={{ color: "var(--muted)" }}>
            <li>
              Скачай{" "}
              <a href="/api/author/skill" data-testid="author-skill-link">
                инструкцию автора (SKILL.md)
              </a>
              : это рабочая инструкция для LLM‑агента (например, Claude Code в клоне репозитория платформы). Расскажи агенту свой инцидент и инфраструктуру, он задаст уточняющие вопросы, напишет сценарий, проверит его командами <code>wom scenario lint|test|run</code> и загрузит на платформу командой <code>wom scenario push</code>. Папку можно собрать и вручную по справочнику формата в том же файле.
            </li>
            <li>Если агент не загружает сам, заархивируй папку в zip (до 5 МБ, внутри должен быть scenario.yaml) и загрузи здесь.</li>
            <li>Формат платформа проверит сразу при загрузке, сборку и регресс запустит модератор: замечания появятся в заявке на этой странице. Исправь их и загрузи архив снова.</li>
          </ol>
          <p className="mt-2" style={{ color: "var(--muted)" }}>
            Команда <code>wom</code> и образцы сценариев лежат в репозитории платформы (<code>npm ci</code>, затем <code>npx wom scenario …</code>). Для <code>push</code> логин и пароль задаются переменными окружения <code>WOM_USER</code> и <code>WOM_PASSWORD</code> в твоём терминале, не в чате с агентом.
          </p>
        </div>
        {mine.length > 0 && (
          <div className="panel p-4 text-sm">
            <h2 className="mb-2 font-semibold">Опубликованы</h2>
            <ul className="flex flex-col gap-1">
              {mine.map((s) => (
                <li key={s.slug} className="flex justify-between gap-2">
                  <span>{s.title}</span>
                  <span style={{ color: "var(--muted)" }}>{s._count.trainingSessions} прохождений</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Заявки</h2>
        {items.length === 0 && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Пока ничего не загружено.
          </p>
        )}
        {items.map((s) => (
          <article key={s.id} className="panel p-4 text-sm" data-testid={`submission-${s.slug}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-semibold">{s.title}</span> <span style={{ color: "var(--muted)" }}>· {s.slug}</span>
              </div>
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                <span>{formatDateTime(s.createdAt)}</span>
                <Badge tone={SUBMISSION_TONE[s.status]} testId="submission-status">
                  {SUBMISSION_STATUS[s.status]}
                </Badge>
              </div>
            </div>
            <SubmissionReport lint={s.lintReport} test={s.testReport} note={s.moderatorNote} />
          </article>
        ))}
        <ShowMore limit={limit} hasMore={rows.length > limit} />
      </section>
    </div>
  );
}
