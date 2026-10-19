// One submission as the moderator must see it before running or publishing anything (ADR-0009): every file of the
// uploaded archive, and what would change if the slug is already in the catalogue.
import type { Metadata } from "next";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@wom/db";
import { ArchiveError, TUTORIAL_SUFFIX, extractScenarioZip, importRecordSchema, importVariants, type ImportRecord } from "@wom/scenario";
import { requireAdminPage } from "@/lib/admin";
import { formatDateTime } from "@/lib/format";
import { LineDiff } from "@/components/line-diff";
import { SubmissionActions } from "@/components/submission-actions";
import { Badge, SUBMISSION_TONE } from "@/components/badge";
import { SubmissionReport, SUBMISSION_STATUS } from "@/components/submission-report";
import { parseEnvironment } from "../../../scenario-json";

export const dynamic = "force-dynamic";

const TEXT_MAX_BYTES = 64 * 1024;
// the page re-renders every few seconds while a test runs: bound how much text one archive can put into it
const INLINE_TOTAL_MAX_BYTES = 1024 * 1024;

type ArchiveFile = { path: string; size: number; text: string | null };

function decodeText(data: Buffer): string | null {
  if (data.byteLength > TEXT_MAX_BYTES || data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

const ROOT_ORDER = ["scenario.yaml", "brief.md", "debrief.md", "guide.md"];

/** files that run on the platform host or inside the stand: shown expanded */
const isExecuted = (p: string) => p.endsWith(".sh") || path.posix.basename(p) === "Dockerfile";

// executed files rank before the rest so that padding the archive with text cannot push them out of the inline budget
function rank(p: string): number {
  const i = ROOT_ORDER.indexOf(p);
  if (i >= 0) return i;
  if (!p.includes("/") && p.endsWith(".sh")) return 10;
  if (path.posix.basename(p) === "Dockerfile") return 20;
  if (isExecuted(p)) return 25;
  if (/\.ya?ml$/.test(p)) return 30;
  return 40;
}

function readArchive(zip: Uint8Array): { files: ArchiveFile[] } | { error: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wom-view-"));
  try {
    const { dir } = extractScenarioZip(zip, tmp);
    const files: ArchiveFile[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else if (e.isFile()) {
          const data = readFileSync(path.join(d, e.name));
          files.push({ path: r, size: data.byteLength, text: decodeText(data) });
        }
      }
    };
    walk(dir, "");
    files.sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let inlined = 0;
    for (const f of files) {
      if (f.text === null) continue;
      inlined += f.size;
      if (inlined > INLINE_TOTAL_MAX_BYTES) f.text = null;
    }
    return { files };
  } catch (err) {
    if (err instanceof ArchiveError) return { error: err.message };
    throw err;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`);

/** JSON with sorted keys: jsonb does not keep the key order of what was stored */
function stable(v: unknown): string {
  return JSON.stringify(
    v ?? null,
    (_k, val) =>
      val && typeof val === "object" && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : val,
    2,
  );
}

const META_KEYS = ["title", "summary", "type", "difficulty", "durationMin", "tags", "contextJson", "eventsJson", "hintsJson", "actionsJson", "gmScriptJson"] as const;
const meta = (s: Record<(typeof META_KEYS)[number], unknown>) => stable(Object.fromEntries(META_KEYS.map((k) => [k, s[k] ?? null])));

const publishedSelect = {
  slug: true,
  isPublished: true,
  updatedAt: true,
  title: true,
  summary: true,
  type: true,
  difficulty: true,
  durationMin: true,
  tags: true,
  contextJson: true,
  eventsJson: true,
  hintsJson: true,
  actionsJson: true,
  gmScriptJson: true,
  briefMd: true,
  debriefMd: true,
  guideMd: true,
  environmentJson: true,
  breakScript: true,
  graderScript: true,
  solutionScript: true,
} as const;

type Change = { label: string; before: string; after: string };

export const metadata: Metadata = { title: "Заявка · админка" };

export default async function AdminSubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  const sub = await prisma.scenarioSubmission.findUnique({
    where: { id },
    select: { id: true, slug: true, title: true, status: true, archive: true, record: true, lintReport: true, testReport: true, moderatorNote: true, createdAt: true, author: { select: { username: true } } },
  });
  if (!sub) notFound();

  const parsed = importRecordSchema.safeParse(sub.record);
  const record: ImportRecord | null = parsed.success ? parsed.data : null;
  const env = parseEnvironment(record?.environmentJson);
  const hints = record?.hintsJson ?? [];
  const archive = readArchive(new Uint8Array(sub.archive));

  // publishing upserts by slug: show what an approval would replace in the catalogue
  let published: { updatedAt: Date; isPublished: boolean } | null = null;
  let changes: Change[] = [];
  if (sub.status !== "APPROVED") {
    const rows = await prisma.scenario.findMany({ where: { slug: { in: [sub.slug, sub.slug + TUTORIAL_SUFFIX] } }, select: publishedSelect });
    const cur = rows.find((r) => r.slug === sub.slug);
    if (cur) {
      published = { updatedAt: cur.updatedAt, isPublished: cur.isPublished };
      if (record) {
        // the catalogue row is the regular copy; the guide lives only in the teaching copy
        const next = importVariants(record).regular;
        const curGuide = rows.find((r) => r.slug !== sub.slug)?.guideMd ?? null;
        const pairs: [string, string | null, string | null][] = [
          ["Метаданные, события и подсказки", meta(cur), meta(next)],
          ["Бриф", cur.briefMd, next.briefMd],
          ["Разбор", cur.debriefMd, next.debriefMd],
          ["Этапы помощи учебной версии", curGuide, record.guideMd],
          ["Окружение и манифесты", stable(cur.environmentJson), stable(next.environmentJson)],
          ["Скрипт поломки", cur.breakScript, next.breakScript],
          ["Скрипт проверки", cur.graderScript, next.graderScript],
          ["Эталонное решение", cur.solutionScript, next.solutionScript],
        ];
        changes = pairs.filter(([, a, b]) => (a ?? "") !== (b ?? "")).map(([label, a, b]) => ({ label, before: a ?? "", after: b ?? "" }));
      }
    }
  }

  const listed = "files" in archive ? archive.files.filter((f) => f.text === null) : [];

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="submission-detail">
      <p>
        <Link href="/admin/submissions">← Все заявки</Link>
      </p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{sub.title}</h1>
          <p className="mt-1" style={{ color: "var(--muted)" }}>
            {sub.slug} · автор {sub.author.username} · {formatDateTime(sub.createdAt)}
            {env && ` · ${env.kind === "kubernetes" ? "Kubernetes" : "Linux‑хост"} · ${env.image ?? ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={SUBMISSION_TONE[sub.status]} testId="admin-submission-status">
            {SUBMISSION_STATUS[sub.status]}
          </Badge>
          <a className="btn" href={`/api/admin/submissions/${sub.id}/archive`} style={{ textDecoration: "none" }} data-testid="submission-archive">
            Скачать zip
          </a>
        </div>
      </div>

      {published && (
        <section className="panel p-4" data-testid="submission-published-diff">
          <h2 className="font-semibold">Сценарий с таким slug уже есть в каталоге</h2>
          <p className="mt-1" style={{ color: "var(--muted)" }}>
            Обновлён {formatDateTime(published.updatedAt)}
            {published.isPublished ? "" : ", сейчас скрыт"}. Публикация заявки заменит его содержимое.{" "}
            {!record ? "Сравнить не с чем: у заявки нет разобранных данных сценария." : changes.length === 0 ? "Содержимое заявки совпадает с опубликованным." : "Что изменится:"}
          </p>
          {changes.map((c) => (
            <details key={c.label} className="spoiler mt-2">
              <summary>{c.label}</summary>
              <LineDiff before={c.before} after={c.after} />
            </details>
          ))}
        </section>
      )}

      {hints.length > 0 && (
        <section className="panel p-4">
          <h2 className="mb-2 font-semibold">Подсказки</h2>
          <ul className="flex flex-col gap-1">
            {hints.map((h, k) => (
              <li key={k}>
                <span style={{ color: "var(--muted)" }}>
                  уровень {String(h.level ?? "?")}, штраф {String(h.penalty ?? 0)}:{" "}
                </span>
                {String(h.text ?? "")}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel p-4" data-testid="submission-files">
        <h2 className="font-semibold">Файлы архива</h2>
        {"error" in archive ? (
          <p className="mt-1" style={{ color: "var(--bad)" }}>
            Архив не удалось распаковать: {archive.error}
          </p>
        ) : (
          <>
            <p className="mt-1" style={{ color: "var(--muted)" }}>
              {archive.files.length} шт., {formatSize(archive.files.reduce((n, f) => n + f.size, 0))}. Dockerfile и скрипты раскрыты: «Проверить» соберёт образ и выполнит их на этом сервере.
            </p>
            {archive.files
              .filter((f) => f.text !== null)
              .map((f) => (
                <details key={f.path} className="spoiler mt-2" open={isExecuted(f.path)}>
                  <summary>
                    <code>{f.path}</code> <span style={{ color: "var(--muted)" }}>· {formatSize(f.size)}</span>
                  </summary>
                  <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-inset p-2 text-xs">{f.text}</pre>
                </details>
              ))}
            {listed.length > 0 && (
              <>
                <p className="mt-3" style={{ color: "var(--muted)" }}>
                  Не показаны (не текст, больше 64 КБ или архив слишком объёмный): смотри в zip.
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {listed.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code> <span style={{ color: "var(--muted)" }}>· {formatSize(f.size)}</span>
                      {isExecuted(f.path) && <span style={{ color: "var(--bad)" }}> · выполняется при проверке, но здесь не показан: прочитай его в zip до запуска</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="panel p-4">
        <h2 className="font-semibold">Проверка и публикация</h2>
        <SubmissionReport lint={sub.lintReport} test={sub.testReport} note={sub.moderatorNote} />
        <SubmissionActions id={sub.id} status={sub.status} />
      </section>
    </div>
  );
}
