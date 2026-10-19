import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@wom/db";
import { extractSections, REFERENCE_SECTIONS, splitGuide, splitSections } from "@wom/scenario";
import { requireUser } from "@/lib/auth";
import { orchestrator, orchestratorPublicUrl, type PlayerSession } from "@/lib/orchestrator";
import { FINAL_STATUSES, playerSessionFromRow } from "@/lib/session-record";
import { contactUrl } from "@/components/contact-link";
import { RefreshButton } from "@/components/refresh-button";
import { SessionView } from "@/components/session-view";
import { parseEnvironment, parseHints } from "../../scenario-json";

export const metadata: Metadata = { title: "Сессия" };

// the columns the player may see: never the runtime handle (a kubeconfig), the client address or the raw error
const SESSION_SELECT = {
  id: true,
  scenarioId: true,
  status: true,
  createdAt: true,
  readyAt: true,
  expiresAt: true,
  finishedAt: true,
  startupMs: true,
  startupPhase: true,
  checkAttempts: true,
  hintsUsed: true,
  score: true,
  result: true,
  lastError: true,
} as const;

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // the database is read first: a finished session no longer changes, and its page must not depend on the orchestrator
  // being up (a deploy, a restart) or still holding the session
  const row = await prisma.trainingSession.findFirst({ where: { id, userId: user.id }, select: SESSION_SELECT });
  if (!row) notFound();
  let session: PlayerSession;
  if (FINAL_STATUSES.has(row.status)) {
    session = playerSessionFromRow(row);
  } else {
    const r = await orchestrator<PlayerSession>(`/sessions/${encodeURIComponent(id)}?userId=${encodeURIComponent(user.id)}`);
    // 404 means the orchestrator does not know it (it is not yours, or it has just ended): the row decides
    if (r.status === 404) {
      session = playerSessionFromRow(row);
    } else if (r.status !== 200) {
      const message = (r.body as { error?: string } | null)?.error;
      return (
        <div className="panel mx-auto max-w-lg p-6" role="alert" data-testid="session-unavailable">
          <h1 className="mb-2 text-xl font-bold">Не удалось загрузить сессию</h1>
          <p className="mb-4 text-sm" style={{ color: "var(--muted)" }}>
            {message ?? "Платформа стендов не ответила."} Обнови страницу через минуту.
          </p>
          <RefreshButton />
        </div>
      );
    } else {
      session = r.body;
    }
  }

  const scenario = await prisma.scenario.findUnique({
    where: { id: session.scenarioId },
    select: { slug: true, title: true, difficulty: true, summary: true, briefMd: true, debriefMd: true, guideMd: true, hintsJson: true, durationMin: true, environmentJson: true },
  });
  if (!scenario) notFound();

  // T-9: the debrief (reference solution) leaves the server only once the session is over
  const finished = FINAL_STATUSES.has(session.status);
  const allHints = parseHints(scenario.hintsJson);
  const hints = allHints.map((h) => ({ level: h.level, penalty: h.penalty }));
  // the hints this session already paid for come back with the page: after a reload, and after the end when the orchestrator no longer serves them
  const openedHints = Object.fromEntries(allHints.flatMap((h) => (session.hintsUsed.includes(h.level) && h.text !== undefined ? [[h.level, h.text] as const] : [])));

  const brief = extractSections(scenario.briefMd ?? scenario.summary, REFERENCE_SECTIONS);

  const env = parseEnvironment(scenario.environmentJson);
  const startup = {
    kind: env?.kind ?? "container",
    expectedSec: env?.startup?.expectedSec ?? (env?.kind === "kubernetes" ? 60 : 5),
    note: env?.startup?.note ?? null,
  };

  return (
    <SessionView
      initial={session}
      scenario={{
        slug: scenario.slug,
        title: scenario.title,
        difficulty: scenario.difficulty,
        brief: splitSections(brief.rest),
        reference: brief.extracted ? splitSections(brief.extracted) : null,
        durationMin: scenario.durationMin,
        hints,
        guide: splitGuide(scenario.guideMd),
        startup,
      }}
      openedHints={openedHints}
      debrief={finished && scenario.debriefMd ? splitSections(scenario.debriefMd) : null}
      serverNow={Date.now()}
      wsBase={orchestratorPublicUrl()}
      contactUrl={contactUrl(`Проблема в сессии ${session.id}`)}
    />
  );
}
