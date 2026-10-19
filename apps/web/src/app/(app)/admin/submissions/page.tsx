import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@wom/db";
import { requireAdminPage } from "@/lib/admin";
import { formatDateTime } from "@/lib/format";
import { Badge, SUBMISSION_TONE } from "@/components/badge";
import { ShowMore, parseLimit } from "@/components/show-more";
import { SubmissionReport, SUBMISSION_STATUS } from "@/components/submission-report";
import { parseRecordEnvironment } from "../../scenario-json";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Заявки · админка" };

export default async function AdminSubmissionsPage({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  await requireAdminPage();
  const limit = parseLimit((await searchParams).limit, 100);
  const rows = await prisma.scenarioSubmission.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: limit + 1,
    select: { id: true, slug: true, title: true, status: true, lintReport: true, testReport: true, moderatorNote: true, createdAt: true, author: { select: { username: true } }, record: true },
  });
  const items = rows.slice(0, limit);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Заявки на сценарии</h1>
      <p className="mb-5 text-sm" style={{ color: "var(--muted)" }}>
        Открой заявку, чтобы посмотреть её файлы: проверка и публикация запускаются с её страницы. «Проверить» собирает образ и гоняет регресс в песочнице на этом сервере, публиковать можно только после
        успешной проверки.
      </p>
      <div className="flex flex-col gap-3">
        {items.length === 0 && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Заявок нет.
          </p>
        )}
        {items.map((s) => {
          const env = parseRecordEnvironment(s.record);
          return (
            <article key={s.id} className="panel p-4 text-sm" data-testid={`admin-submission-${s.slug}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">{s.title}</span> <span style={{ color: "var(--muted)" }}>· {s.slug} · автор {s.author.username}</span>
                  {env && (
                    <span style={{ color: "var(--muted)" }}>
                      {" "}
                      · {env.kind === "kubernetes" ? "Kubernetes" : "Linux‑хост"} · {env.image}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                  <span>{formatDateTime(s.createdAt)}</span>
                  <Badge tone={SUBMISSION_TONE[s.status]} testId="admin-submission-status">
                    {SUBMISSION_STATUS[s.status]}
                  </Badge>
                </div>
              </div>
              <SubmissionReport lint={s.lintReport} test={s.testReport} note={s.moderatorNote} />
              <div className="mt-3">
                <Link className="btn" href={`/admin/submissions/${s.id}`} prefetch={false} style={{ textDecoration: "none" }} data-testid="submission-open">
                  Открыть заявку: файлы и действия
                </Link>
              </div>
            </article>
          );
        })}
      </div>
      <ShowMore limit={limit} hasMore={rows.length > limit} />
    </div>
  );
}
