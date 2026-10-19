import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@wom/db";
import { parseScenarioContext, TUTORIAL_SUFFIX } from "@wom/scenario";
import { requireUser } from "@/lib/auth";
import { ACTIVE_SESSION_STATUSES } from "@/lib/admin";
import { DIFFICULTY, FINAL_SESSION_STATUSES } from "@/lib/labels";
import { getCapacity } from "@/lib/capacity";
import { DIFFICULTY_TONE, KIND_TONE, TUTORIAL_TONE, tone } from "@/lib/tones";
import { ProgressBadge, type Progress } from "@/components/progress-badge";
import { StartButton } from "@/components/start-button";
import { parseEnvironment, parseHints } from "../../scenario-json";


function startupText(sec: number) {
  if (sec < 10) return "несколько секунд";
  if (sec < 90) return `около ${sec} с`;
  return `около ${Math.round(sec / 60)} мин`;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const s = await prisma.scenario.findUnique({ where: { slug }, select: { title: true, isPublished: true } });
  return s?.isPublished ? { title: s.title } : {};
}

/** The scenario card opened from the catalogue: what the incident is about and what starting it costs.
 *  The stand is created only when the person presses "Запустить" here, never from the list. */
export default async function ScenarioPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const s = await prisma.scenario.findUnique({
    where: { slug },
    select: { id: true, slug: true, title: true, summary: true, type: true, difficulty: true, durationMin: true, tags: true, isPublished: true, contextJson: true, hintsJson: true, environmentJson: true },
  });
  const env = s ? parseEnvironment(s.environmentJson) : null;
  if (!s || !s.isPublished || !env) notFound();

  const isK8s = env.kind === "kubernetes";
  const ctx = parseScenarioContext(s.contextJson);
  const hints = parseHints(s.hintsJson);
  const startupSec = env.startup?.expectedSec ?? (isK8s ? 60 : 5);
  const ttlMin = env.ttlMin ?? 45;
  const isTutorial = s.tags.includes("tutorial");

  const twinSlug = s.slug.endsWith(TUTORIAL_SUFFIX) ? s.slug.slice(0, -TUTORIAL_SUFFIX.length) : s.slug + TUTORIAL_SUFFIX;
  const [twin, active, capacity, solvedBest, triedCount] = await Promise.all([
    prisma.scenario.findFirst({ where: { slug: twinSlug, isPublished: true }, select: { slug: true } }),
    prisma.trainingSession.findFirst({
      where: { userId: user.id, status: { in: [...ACTIVE_SESSION_STATUSES] } },
      select: { id: true, scenario: { select: { title: true } } },
    }),
    getCapacity(),
    prisma.trainingSession.aggregate({ where: { userId: user.id, scenarioId: s.id, status: "FINISHED" }, _count: { _all: true }, _max: { score: true } }),
    prisma.trainingSession.count({ where: { userId: user.id, scenarioId: s.id, status: { in: [...FINAL_SESSION_STATUSES] } } }),
  ]);
  const progress: Progress | null = solvedBest._count._all > 0 ? { state: "solved", score: solvedBest._max.score } : triedCount > 0 ? { state: "tried", score: null } : null;
  const full = capacity ? capacity.all.active >= capacity.all.max || (isK8s && capacity.kubernetes.active >= capacity.kubernetes.max) : false;

  return (
    <div className="mx-auto max-w-5xl" data-testid="scenario-detail">
      <p className="mb-3 text-sm">
        <Link href="/scenarios">← Все сценарии</Link>
      </p>
      <div className="grid gap-5 md:grid-cols-[1fr_300px]">
        <section className="panel tile p-6" style={tone(DIFFICULTY_TONE[s.difficulty])}>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="pill pill-dot">{DIFFICULTY[s.difficulty]}</span>
            <span className="pill" style={tone(KIND_TONE[isK8s ? "kubernetes" : "container"])}>
              {isK8s ? "Kubernetes" : "Linux‑хост"}
            </span>
            {isTutorial && (
              <span className="pill" style={tone(TUTORIAL_TONE)}>
                🎓 учебный
              </span>
            )}
            <ProgressBadge progress={progress} />
          </div>
          <h1 className="text-3xl font-extrabold leading-tight">{s.title}</h1>
          <p className="mt-3 leading-relaxed">{s.summary}</p>

          {(ctx.infra || ctx.setup || ctx.time || (ctx.services?.length ?? 0) > 0) && (
            <>
              <h2 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Обстановка
              </h2>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[120px_1fr]">
                {ctx.time && <Row k="Когда" v={ctx.time} />}
                {ctx.infra && <Row k="Где" v={ctx.infra} />}
                {(ctx.services?.length ?? 0) > 0 && <Row k="Сервисы" v={ctx.services!.join(", ")} />}
                {ctx.setup && <Row k="Что было до" v={ctx.setup} />}
              </dl>
            </>
          )}

          <h2 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            Как это устроено
          </h2>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
            <li>По кнопке «Запустить» для тебя поднимается отдельный стенд, уже сломанный. Таймер пойдёт, когда стенд будет готов.</li>
            <li>В браузере откроется терминал и бриф: что известно, что нужно починить и какие есть ограничения.</li>
            <li>«Проверить» оценивает результат, а не способ. Пока не решено, проверять можно сколько угодно раз.</li>
            <li>Когда проверка пройдена, сессия завершается и стенд удаляется. То же будет, если нажать «Сдаться»: откроется разбор с эталонным решением.</li>
          </ol>
          {isTutorial && (
            <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
              В учебной версии есть панель «Нужна помощь?»: этапы диагностики открываются по одному и объясняют, зачем нужна каждая команда.
            </p>
          )}
          {twin && (
            <p className="mt-3 text-sm">
              {isTutorial ? "Уже уверенно чувствуешь себя в теме? " : "Нужна поддержка по шагам? "}
              <Link href={`/scenarios/${twin.slug}`} data-testid="scenario-twin">
                {isTutorial ? "Открыть обычную версию без этапов помощи" : "Открыть учебную версию с этапами помощи"}
              </Link>
            </p>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <div className="panel p-5">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
              <Row k="Стенд" v={isK8s ? "Kubernetes" : "Linux‑хост"} />
              <Row k="Тема" v={s.type} />
              <Row k="На решение" v={`около ${s.durationMin} мин`} />
              <Row k="Подъём" v={startupText(startupSec)} />
              <Row k="Стенд живёт" v={`${ttlMin} мин`} />
              <Row k="Подсказки" v={hints.length ? hints.map((h) => (h.penalty ? `−${h.penalty}` : "бесплатно")).join(", ") : "нет"} />
            </dl>
            {env.startup?.note && (
              <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
                {env.startup.note}
              </p>
            )}
          </div>

          <div className="panel p-5">
            {active ? (
              <div className="flex flex-col gap-3 text-sm" data-testid="active-session-note">
                <p>
                  У тебя уже идёт сессия: <strong>{active.scenario.title}</strong>. Одновременно можно держать один стенд.
                </p>
                <Link className="btn btn-primary justify-center" href={`/sessions/${active.id}`} style={{ textDecoration: "none" }}>
                  Вернуться к сессии
                </Link>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <StartButton scenarioId={s.id} />
                <p className="text-xs" style={{ color: full ? "var(--bad)" : "var(--muted)" }} data-testid="start-note">
                  {full
                    ? "Сейчас все слоты заняты: запуск вернёт отказ с оценкой, когда освободится ближайший."
                    : `Стенд поднимется за ${startupText(startupSec)}. Передумаешь во время подъёма: кнопка «Остановить» на странице сессии всё отменит.`}
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ color: "var(--muted)" }}>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
