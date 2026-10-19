"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { SandboxPhase } from "@wom/runtime";
import { checkAnnouncement } from "@/lib/announce";
import { DIFFICULTY, fmtSeconds, SESSION_STATUS } from "@/lib/labels";
import { DIFFICULTY_TONE, KIND_TONE, tone } from "@/lib/tones";
import type { GraderResult, PlayerSession } from "@/lib/orchestrator";
import { startPoller } from "@/lib/poller";
import { postJson, POST_TIMEOUT_MS } from "@/lib/post-json";
import { Badge, SESSION_TONE } from "./badge";
import { Markdown } from "./markdown";
import { Terminal } from "./terminal";
import { useFocusWhen } from "./use-focus";
import { useNow } from "./use-now";

type Section = { title: string; md: string };
type Doc = { preamble: string; sections: Section[] };

type Props = {
  initial: PlayerSession;
  scenario: {
    slug: string;
    title: string;
    difficulty: "JUNIOR" | "MIDDLE" | "SENIOR";
    brief: Doc;
    /** cheat sheet + pre-reading: a third column beside the terminal on wide screens, a collapsed block otherwise */
    reference: Doc | null;
    durationMin: number;
    hints: { level: number; penalty: number }[];
    /** teaching stages (guide.md), revealed one by one, free of charge */
    guide: { title: string; md: string }[];
    startup: { kind: "container" | "kubernetes"; expectedSec: number; note: string | null };
  };
  /** text of the hints this session already opened, so they survive a reload (also after the session is over) */
  openedHints: Record<number, string>;
  debrief: Doc | null;
  /** the time the server rendered the page at: the first render of every clock, so the browser's markup matches the server's */
  serverNow: number;
  wsBase: string;
  /** the feedback link from CONTACT_URL (read on the server); null when none is configured */
  contactUrl: string | null;
};

/**
 * markdown document whose `## ` sections are collapsible.
 * Memoized with the documents it gets (the same objects on every render of the page): the page ticks and polls, the text does not change.
 */
export const CollapsibleDoc = memo(function CollapsibleDoc({ doc, testId }: { doc: Doc; testId?: string }) {
  return (
    <div className="prose-wom" data-testid={testId}>
      {doc.preamble && <Markdown>{doc.preamble}</Markdown>}
      {doc.sections.map((s, i) => (
        // two sections may carry the same title: the title alone is not a key
        <details key={`${i}:${s.title}`} open className="doc-section spoiler">
          <summary>{s.title}</summary>
          <div className="doc-section-body">
            <Markdown>{s.md}</Markdown>
          </div>
        </details>
      ))}
    </div>
  );
});

// the live view says what is happening right now, so a few labels are longer than in the lists
const STATUS_LABEL: Record<PlayerSession["status"], string> = {
  ...SESSION_STATUS,
  PROVISIONING: "поднимаем окружение…",
  CHECKING: "проверяем…",
  FAILED: "ошибка окружения",
};

// a poll that hangs is as good as a failed one: say "offline" instead of waiting for the browser's own timeout
const POLL_TIMEOUT_MS = 15_000;

const OVER = new Set<PlayerSession["status"]>(["FINISHED", "EXPIRED", "KILLED", "FAILED"]);

// provisioning phases reported by the runtime (SandboxPhase) and the orchestrator ("queued", "break"); a new runtime phase fails the type check here
type Phase = SandboxPhase | "queued" | "break";
const PHASE_LABEL = {
  queued: "ждём свободный слот: другие кластеры ещё поднимаются",
  sandbox: "создаём песочницу",
  cluster: "создаём кластер Kubernetes",
  images: "загружаем образы в кластер",
  tools: "готовим рабочее место (bastion)",
  manifests: "разворачиваем приложения",
  break: "ломаем окружение по сценарию",
} satisfies Record<Phase, string>;
const PHASES = {
  container: ["sandbox", "break"],
  kubernetes: ["cluster", "images", "tools", "manifests", "break"],
} satisfies Record<"container" | "kubernetes", Phase[]>;

const labelOf = (phase: string): string | undefined => (PHASE_LABEL as Record<string, string>)[phase];

function fmtExpected(sec: number) {
  return sec >= 60 ? `${Math.round(sec / 60)} мин` : `${sec} с`;
}

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** the environment is coming up: the phase, the wait against the usual time, and every phase of the way (right column, where the terminal will be) */
export function StartupProgress({
  phase,
  phases,
  createdAt,
  serverNow,
  expectedSec,
  note,
}: {
  phase: string | null;
  phases: readonly string[];
  createdAt: string;
  serverNow: number;
  expectedSec: number;
  note: string | null;
}) {
  const now = useNow(serverNow, true);
  const waited = now - new Date(createdAt).getTime();
  const phaseIdx = phase ? phases.indexOf(phase) : -1;
  // progress: 60 % by phases reached, 37 % by time against the usual wait, never "done"
  const progress = Math.min(97, Math.round(((phaseIdx + 1) / (phases.length + 1)) * 60 + Math.min(waited / (expectedSec * 1000), 1) * 37));
  return (
    <div className="panel flex flex-1 flex-col justify-center gap-5 p-6 md:p-8" data-testid="startup-progress">
      <div>
        {/* the phase is read out when it changes; the clock under it is not part of the live region, it would speak every second */}
        <div role="status">
          <h2 className="text-base font-semibold">{capitalize(phase ? (labelOf(phase) ?? phase) : "ставим в очередь")}…</h2>
        </div>
        <p className="mt-1 text-sm tabular-nums" style={{ color: "var(--muted)" }}>
          {fmt(waited)} · обычно около {fmtExpected(expectedSec)}
        </p>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded bg-inset"
        role="progressbar"
        aria-label="Подъём окружения"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <div className="h-full rounded transition-[width] duration-1000" style={{ width: `${progress}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))", boxShadow: "0 0 12px rgba(240,180,41,0.6)" }} />
      </div>
      <ol className="flex flex-col gap-1.5 text-sm" style={{ color: "var(--muted)" }}>
        {phases.map((p, i) => (
          <li key={p} style={{ color: i < phaseIdx ? "var(--ok)" : i === phaseIdx ? "var(--text)" : undefined }}>
            {i < phaseIdx ? "✔ " : i === phaseIdx ? <span className="animate-pulse" style={{ color: "var(--accent)" }}>● </span> : "○ "}
            {capitalize(labelOf(p) ?? p)}
          </li>
        ))}
      </ol>
      {note && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {note}
        </p>
      )}
      {waited > expectedSec * 1500 && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Дольше обычного, но окружение ещё поднимается. Если через {Math.max(1, Math.round((expectedSec * 3) / 60))} мин ничего не изменится, останови
          сессию и запусти заново.
        </p>
      )}
    </div>
  );
}

/**
 * The three figures under the title. The clock lives here and not in SessionView: the page used to re-render in full every
 * second, markdown included, only to move these digits.
 */
export function Timers({ session, durationMin, over, serverNow }: { session: PlayerSession; durationMin: number; over: boolean; serverNow: number }) {
  const now = useNow(serverNow, !over);
  if (!session.readyAt) return null;
  const readyAt = new Date(session.readyAt).getTime();
  const elapsed = now - readyAt;
  const remaining = session.expiresAt ? new Date(session.expiresAt).getTime() - now : 0;
  // timer tones: past the target time the pace is behind (accent), the last 5 minutes before deletion warn (accent), the last minute is red
  const elapsedTone = !over && elapsed > durationMin * 60_000 ? "var(--accent)" : undefined;
  const remainingTone = over || !session.expiresAt ? undefined : remaining < 60_000 ? "var(--bad)" : remaining < 300_000 ? "var(--accent)" : undefined;
  return (
    <div className="grid grid-cols-3 gap-2 text-center text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
      <div className="rounded-lg bg-inset px-1 py-2">
        <div className="font-mono text-lg font-semibold normal-case tabular-nums text-[var(--text)]" style={{ color: elapsedTone }} data-testid="elapsed">
          {fmt(over && session.finishedAt ? new Date(session.finishedAt).getTime() - readyAt : elapsed)}
        </div>
        <span title="Сколько прошло с момента, когда стенд стал готов">прошло</span>
      </div>
      <div className="rounded-lg bg-inset px-1 py-2">
        <div className="font-mono text-lg font-semibold normal-case tabular-nums text-[var(--text)]">{durationMin}:00</div>
        <span title="Ориентир: за это время сценарий обычно решают">цель</span>
      </div>
      <div className="rounded-lg bg-inset px-1 py-2">
        <div className="font-mono text-lg font-semibold normal-case tabular-nums text-[var(--text)]" style={{ color: remainingTone ?? (over ? undefined : "var(--ok)") }}>
          {over ? "—" : fmt(remaining)}
        </div>
        <span title="Через сколько стенд удалится сам, даже если ты ничего не делаешь. Продлить нельзя">до удаления</span>
      </div>
    </div>
  );
}

/**
 * The stand is deleted at expiresAt and cannot be extended: say so while there is still time to check.
 * The live region is always in the page and the warning comes into it, so a screen reader speaks it (a region that
 * appears together with its text is often skipped).
 */
export function TtlWarning({ running, expiresAt, serverNow }: { running: boolean; expiresAt: string | null; serverNow: number }) {
  const now = useNow(serverNow, running && expiresAt !== null);
  const remaining = expiresAt ? new Date(expiresAt).getTime() - now : 0;
  const level = running && expiresAt ? (remaining < 60_000 ? "minute" : remaining < 300_000 ? "five" : null) : null;
  return (
    // an empty region takes no room: the negative margin takes back the gap of the column it sits in
    <div role="status" className="empty:-mb-3">
      {level && (
        <p
          className="panel px-4 py-2 text-sm"
          style={{
            borderColor: level === "minute" ? "var(--bad)" : "var(--accent)",
            background: `color-mix(in srgb, ${level === "minute" ? "var(--bad)" : "var(--accent)"} 10%, var(--panel))`,
          }}
          data-testid="ttl-warning"
        >
          {level === "minute"
            ? "Меньше минуты до удаления стенда. Продлить сессию нельзя: если решение готово, жми «Проверить» сейчас."
            : "Меньше 5 минут до удаления стенда. Продлить сессию нельзя: сохрани нужное и проверь решение, пока стенд жив."}
        </p>
      )}
    </div>
  );
}

/** a stage of the teaching guide; the one the person has just opened takes the focus (the button that opened it moved down or went away) */
function GuideStage({ n, stage, focus }: { n: number; stage: { title: string; md: string }; focus: boolean }) {
  const ref = useFocusWhen<HTMLLIElement>(focus);
  return (
    <li ref={ref} tabIndex={-1} className="prose-wom rounded-md border border-[var(--border)] border-l-[3px] border-l-[var(--ok)] bg-inset/60 p-3" data-testid={`guide-stage-${n}`}>
      <p className="mt-0 font-semibold">
        {n}. {stage.title}
      </p>
      <Markdown>{stage.md}</Markdown>
    </li>
  );
}

/** the text of an opened hint; it takes the focus when the person has just opened it (the button they pressed is gone) */
function HintText({ text, focus }: { text: string; focus: boolean }) {
  const ref = useFocusWhen<HTMLParagraphElement>(focus);
  return (
    <p ref={ref} tabIndex={-1} className="mt-1">
      {text}
    </p>
  );
}

/** the hints of the scenario: they open strictly in order, the paid ones after a confirmation */
function HintsPanel({
  hints,
  opened,
  nextLevel,
  canOpen,
  busy,
  focusLevel,
  onOpen,
}: {
  hints: { level: number; penalty: number }[];
  opened: Record<number, string>;
  nextLevel: number | null;
  canOpen: boolean;
  busy: string | null;
  /** the level the person has just opened in this view; null after a plain page load */
  focusLevel: number | null;
  onOpen: (level: number, penalty: number) => void;
}) {
  return (
    <section className="panel p-4 text-sm max-lg:order-3">
      <h2 className="mb-2 font-semibold">💡 Подсказки</h2>
      <ol className="flex flex-col gap-2">
        {hints.map((h) => (
          <li key={h.level} className="rounded-md border border-[var(--border)] bg-inset/50 p-2">
            <div className="flex items-center justify-between text-xs" style={{ color: "var(--muted)" }}>
              <span>Уровень {h.level}</span>
              <span className="pill" style={tone(h.penalty === 0 ? "var(--ok)" : h.penalty >= 15 ? "var(--bad)" : "var(--accent)")}>
                {h.penalty ? `−${h.penalty} баллов` : "бесплатно"}
              </span>
            </div>
            {opened[h.level] ? (
              <HintText text={opened[h.level]} focus={focusLevel === h.level} />
            ) : (
              canOpen &&
              nextLevel === h.level && (
                <button className="btn mt-2 px-3 py-1 text-xs" onClick={() => onOpen(h.level, h.penalty)} disabled={busy !== null} data-testid={`hint-${h.level}`}>
                  Открыть
                </button>
              )
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SessionView({ initial, scenario, openedHints, debrief, serverNow, wsBase, contactUrl }: Props) {
  const router = useRouter();
  const [session, setSession] = useState<PlayerSession>(initial);
  const [result, setResult] = useState<GraderResult | null>(initial.result);
  // the result panel sits above the terminal and opens itself on every new result
  const [resultOpen, setResultOpen] = useState(true);
  const resultRef = useRef<HTMLDetailsElement>(null);
  // counts the verdicts received in this view; each one moves the focus to the panel, which has just appeared or changed
  const [resultTick, setResultTick] = useState(0);
  const checkRef = useRef<HTMLButtonElement>(null);
  const [hints, setHints] = useState<Record<number, string>>(openedHints);
  // the hint and the guide stage the person has just opened here get the keyboard focus; nothing is focused after a plain page load
  const [focusHint, setFocusHint] = useState<number | null>(null);
  const [focusStage, setFocusStage] = useState<number | null>(null);
  // how many guide stages the player has opened; a per-viewer convenience, so localStorage is fine
  const [guideOpen, setGuideOpen] = useState(0);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(`wom.guide.${initial.id}`) ?? 0);
      if (v > 0) setGuideOpen(Math.min(v, scenario.guide.length));
    } catch {}
  }, [initial.id, scenario.guide.length]);
  const openStage = () => {
    const n = Math.min(guideOpen + 1, scenario.guide.length);
    setGuideOpen(n);
    setFocusStage(n);
    try {
      localStorage.setItem(`wom.guide.${initial.id}`, String(n));
    } catch {}
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasOver = useRef(OVER.has(initial.status));
  // true when the page was opened on a session that is already over: nothing then moves the focus to the debrief
  const openedOver = useRef(OVER.has(initial.status));

  // the platform did not answer the last poll: the page keeps what it knows and says so
  const [offline, setOffline] = useState(false);

  // every response goes through here: a late one must not bring an ended session back to life
  // (the terminal would reconnect to a stand that is already deleted)
  const applySession = useCallback((s: PlayerSession) => {
    setSession((prev) => (OVER.has(prev.status) && !OVER.has(s.status) ? prev : s));
    if (s.result) setResult(s.result);
  }, []);

  // Answers can overtake each other (a poll that was slow, a check that was quick): each request takes a number when it
  // starts, and an answer older than the newest one already shown is dropped. The response to the player's own action
  // (check, give up) counts as the newest at once.
  const requested = useRef(0);
  const shown = useRef(0);
  const newest = () => (shown.current = ++requested.current);

  const refresh = useCallback(async () => {
    const seq = ++requested.current;
    try {
      const r = await fetch(`/api/sessions/${session.id}`, { cache: "no-store", signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      if (!r.ok) {
        if (seq >= shown.current) setOffline(r.status >= 500);
        return;
      }
      const s = (await r.json()) as PlayerSession;
      if (seq < shown.current) return;
      shown.current = seq;
      applySession(s);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [session.id, applySession]);

  // poll: fast while transitioning, slow while running (to notice TTL expiry / admin kill). One request at a time,
  // none while the tab is in the background, and one at once when it comes back.
  useEffect(() => {
    if (OVER.has(session.status)) return;
    const poller = startPoller({
      run: refresh,
      intervalMs: () => (session.status === "RUNNING" ? 10_000 : 2_000),
      isHidden: () => document.hidden,
    });
    const onVisible = () => {
      if (!document.hidden) poller.poke();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session.status, refresh]);

  // when the session ends, re-render on the server to receive the debrief
  useEffect(() => {
    if (OVER.has(session.status) && !wasOver.current) {
      wasOver.current = true;
      router.refresh();
    }
  }, [session.status, router]);

  // the clocks (Timers, TtlWarning, StartupProgress) tick on their own: this component does not re-render every second
  const over = OVER.has(session.status);

  // the verdict: the panel is the place to read it, so the focus goes there
  useEffect(() => {
    if (resultTick === 0) return;
    const panel = resultRef.current;
    if (!panel) return;
    panel.querySelector("summary")?.focus({ preventScroll: true });
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [resultTick]);

  // The session ended while the page was open: the terminal that held the focus is gone, so the debrief (or, when there
  // is none, the note that the stand is deleted) takes it. Both panels carry the ref; a page opened on a finished session is left alone.
  const endPanel = useRef<HTMLElement | null>(null);
  const setEndPanel = useCallback((el: HTMLElement | null) => {
    endPanel.current = el;
  }, []);
  const endKey = debrief ? "debrief" : over ? "gone" : null;
  useEffect(() => {
    if (endKey && !openedOver.current) endPanel.current?.focus();
  }, [endKey]);

  async function post(action: string, body?: unknown) {
    const r = await postJson(`/api/sessions/${session.id}/${action}`, body, { timeoutMs: action === "check" ? POST_TIMEOUT_MS.check : POST_TIMEOUT_MS.default });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  async function check() {
    setBusy("check");
    setError(null);
    try {
      const data = (await post("check")) as { session: PlayerSession; result: GraderResult };
      newest();
      applySession(data.session);
      setResult(data.result);
      setResultOpen(true);
      setResultTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openHint(level: number, penalty: number) {
    if (penalty > 0 && !confirm(`Открыть подсказку ${level} за −${penalty} баллов? Штраф вернуть нельзя.`)) return;
    setBusy(`hint-${level}`);
    setError(null);
    try {
      const data = (await post("hints", { level })) as { text: string };
      setHints((h) => ({ ...h, [level]: data.text }));
      setFocusHint(level);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // while the stand is still coming up this is a cancel; later it is giving up, and the debrief opens either way
  async function stop() {
    const ok = confirm(
      provisioning
        ? "Остановить запуск? Стенд будет удалён, откроется разбор."
        : "Сдаться? Стенд будет удалён, откроется разбор с эталонным решением. Вернуться в стенд уже не получится.",
    );
    if (!ok) return;
    setBusy("stop");
    setError(null);
    try {
      const r = await postJson<PlayerSession>(`/api/sessions/${session.id}`, undefined, { method: "DELETE", timeoutMs: POST_TIMEOUT_MS.stop });
      if (!r.ok) throw new Error(r.error);
      newest();
      applySession(r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const running = session.status === "RUNNING" || session.status === "CHECKING";
  const nextHint = scenario.hints.find((h) => !session.hintsUsed.includes(h.level));
  const provisioning = session.status === "REQUESTED" || session.status === "PROVISIONING";
  const phases: readonly string[] = PHASES[scenario.startup.kind];
  const resultTone = result && result.status === "ok" && result.passed ? "var(--ok)" : "var(--bad)";
  // the terminal's double Escape lands on the Check button: the next thing to do, and a place from which Tab and Shift+Tab both work
  const focusCheck = useCallback(() => {
    const b = checkRef.current;
    if (!b || b.disabled) return false;
    b.focus();
    return true;
  }, []);

  return (
    <div
      className={
        "grid gap-4 lg:h-[calc(100dvh-7.75rem)] lg:min-h-[520px] lg:grid-cols-[420px_1fr] " +
        // with reference material the page breaks out of the 72rem app container: brief | terminal | reference
        (scenario.reference ? "xl:relative xl:left-1/2 xl:w-[min(100vw-3rem,1700px)] xl:-translate-x-1/2 xl:grid-cols-[400px_1fr_320px]" : "")
      }
    >
      {/* on wide screens the brief scrolls inside its own column while the terminal stays put */}
      {/* below lg the aside dissolves into the grid: title and status, then the terminal, then the brief and the helps */}
      <aside className="flex flex-col gap-4 max-lg:contents lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        <section className="panel tile shrink-0 p-4 max-lg:order-1" style={tone(DIFFICULTY_TONE[scenario.difficulty])}>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="pill pill-dot">{DIFFICULTY[scenario.difficulty]}</span>
            <span className="pill" style={tone(KIND_TONE[scenario.startup.kind])}>
              {scenario.startup.kind === "kubernetes" ? "Kubernetes" : "Linux‑хост"}
            </span>
          </div>
          <div className="mb-3 flex items-start justify-between gap-2">
            <h1 className="min-w-0 text-lg font-extrabold leading-snug">{scenario.title}</h1>
            <Badge tone={SESSION_TONE[session.status]} testId="session-status" live>
              {STATUS_LABEL[session.status]}
            </Badge>
          </div>
          {offline && !over && (
            <p className="mb-2 text-xs" style={{ color: "var(--accent)" }} role="status" data-testid="offline">
              Нет связи с платформой: показываю последнее, что знаю. Пробую снова.
            </p>
          )}
          <Timers session={session} durationMin={scenario.durationMin} over={over} serverNow={serverNow} />
          {session.startupMs != null && (
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              окружение поднялось за {fmtSeconds(session.startupMs)}
            </p>
          )}
          {session.status === "FAILED" && (
            <p className="mt-2 text-sm" style={{ color: "var(--bad)" }}>
              {session.lastError ?? "не удалось поднять окружение"}
            </p>
          )}
        </section>

        <section id="brief" className="panel scroll-mt-4 p-4 text-sm max-lg:order-3">
          <CollapsibleDoc doc={scenario.brief} testId="brief" />
        </section>

        {scenario.guide.length > 0 && (
          <section className="panel p-4 text-sm max-lg:order-3" style={{ borderColor: "color-mix(in srgb, var(--ok) 40%, var(--border))", background: "linear-gradient(180deg, color-mix(in srgb, var(--ok) 8%, var(--panel-2)), var(--panel) 70%)" }} data-testid="guide">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold" style={{ color: "var(--ok)" }}>
                🎓 Нужна помощь?
              </h2>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {guideOpen} / {scenario.guide.length} · бесплатно
              </span>
            </div>
            {guideOpen === 0 && (
              <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
                Учебный кейс: помощь по диагностике открывается по одному этапу. Сначала попробуй сам, потом жми кнопку.
              </p>
            )}
            <ol className="flex flex-col gap-2">
              {scenario.guide.slice(0, guideOpen).map((g, i) => (
                <GuideStage key={i} n={i + 1} stage={g} focus={focusStage === i + 1} />
              ))}
            </ol>
            {guideOpen < scenario.guide.length && !over && (
              <button className="btn mt-2 px-3 py-1 text-xs" onClick={openStage} data-testid="guide-next">
                {guideOpen === 0 ? "Не знаю, что делать" : "Дальше"}
              </button>
            )}
          </section>
        )}

        {scenario.hints.length > 0 && (
          <HintsPanel hints={scenario.hints} opened={hints} nextLevel={nextHint?.level ?? null} canOpen={running} busy={busy} focusLevel={focusHint} onOpen={openHint} />
        )}

        {scenario.reference && (
          <details className="panel spoiler p-4 text-sm max-lg:order-3 xl:hidden">
            <summary className="font-semibold">📎 Справка: шпаргалка и что почитать</summary>
            <div className="mt-2">
              <CollapsibleDoc doc={scenario.reference} />
            </div>
          </details>
        )}

      </aside>

      <section className="flex min-h-[520px] flex-col gap-3 max-lg:order-2 lg:min-h-0">
        {/* on a phone the buttons stay on screen while the terminal scrolls */}
        {/* it sticks under the app header, not behind it (--nav-h is its measured height) */}
        <div data-sticky-actions className="flex flex-wrap items-center gap-2 max-lg:sticky max-lg:top-[var(--nav-h)] max-lg:z-10 max-lg:bg-[var(--bg)] max-lg:py-2">
          <button ref={checkRef} className="btn btn-primary" onClick={check} disabled={!running || busy !== null} data-testid="check">
            {busy === "check" ? "Проверяем…" : "✓ Проверить"}
          </button>
          {!over && (
            <button className="btn" onClick={stop} disabled={busy !== null} data-testid="stop" title="Стенд удалится, откроется разбор с эталонным решением">
              {provisioning ? "Остановить" : "Сдаться и открыть разбор"}
            </button>
          )}
          {(session.status === "FAILED" || session.status === "EXPIRED") && (
            <Link className="btn btn-primary no-underline" href={`/scenarios/${scenario.slug}`} data-testid="restart">
              Запустить заново
            </Link>
          )}
          {over && (
            <Link className="btn no-underline" href="/scenarios">
              К сценариям
            </Link>
          )}
          <a href="#brief" className="text-xs lg:hidden">
            Бриф ↓
          </a>
          {error && (
            <span className="text-sm" style={{ color: "var(--bad)" }} role="alert">
              {error}
            </span>
          )}
        </div>
        {(running || contactUrl) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
            {running && <span>Когда проверка пройдена, сессия завершается и стенд удаляется. «Сдаться» делает то же и сразу открывает разбор.</span>}
            {contactUrl && (
              <span className="ml-auto">
                <a href={contactUrl} target="_blank" rel="noreferrer" data-testid="report-problem" style={{ color: "var(--muted)" }}>
                  Сообщить о проблеме
                </a>
                {" · сессия "}
                <span className="select-all break-all" title="Приложи этот номер к сообщению">
                  {session.id}
                </span>
              </span>
            )}
          </div>
        )}
        <TtlWarning running={running} expiresAt={session.expiresAt} serverNow={serverNow} />
        {/* a live region that exists before the result does: the new result is read out, the panel below is not.
            The attempt number makes a repeated "не решено" a new text, so it is spoken again; the unmet criteria are named */}
        <p className="sr-only" role="status" data-testid="check-announce">
          {checkAnnouncement(result, session.checkAttempts)}
        </p>
        {result && (
          <details
            ref={resultRef}
            open={resultOpen}
            onToggle={(e) => setResultOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="panel spoiler px-4 py-3 text-sm"
            style={{
              borderColor: `color-mix(in srgb, ${resultTone} 55%, var(--border))`,
              background: `linear-gradient(180deg, color-mix(in srgb, ${resultTone} 10%, var(--panel-2)), var(--panel) 80%)`,
            }}
            data-testid="check-result"
          >
            <summary className="flex items-center gap-2 font-semibold">
              <span>Результат проверки:</span>
              {result.status === "error" ? (
                <span style={{ color: "var(--bad)" }}>проверка не удалась</span>
              ) : (
                <span style={{ color: result.passed ? "var(--ok)" : "var(--bad)" }}>
                  {result.passed ? "Решено" : "Не решено"} · {result.criteria.filter((c) => c.ok).length} из {result.criteria.length}
                </span>
              )}
              {session.score != null && (
                <span className="font-normal" style={{ color: "var(--muted)" }}>
                  · Баллы: <strong className="text-[var(--text)]">{session.score}</strong> / 100
                </span>
              )}
            </summary>
            <div className="mt-2">
              {result.status === "error" ? (
                <p style={{ color: "var(--bad)" }}>Проверка не удалась: {result.error}. Попробуй ещё раз.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {result.criteria.map((c) => (
                    <li key={c.id} className="flex gap-2 rounded-md px-2 py-1" style={{ background: `color-mix(in srgb, ${c.ok ? "var(--ok)" : "var(--bad)"} 9%, transparent)` }}>
                      <span style={{ color: c.ok ? "var(--ok)" : "var(--bad)" }}>
                        <span aria-hidden="true">{c.ok ? "✔" : "✘"}</span>
                        <span className="sr-only">{c.ok ? "выполнено: " : "не выполнено: "}</span>
                      </span>
                      <span>{c.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}
        {running ? (
          <Terminal sessionId={session.id} wsBase={wsBase} onExit={focusCheck} />
        ) : provisioning ? (
          <StartupProgress
            phase={session.startupPhase}
            phases={phases}
            createdAt={session.createdAt}
            serverNow={serverNow}
            expectedSec={scenario.startup.expectedSec}
            note={scenario.startup.note}
          />
        ) : (
          debrief ? (
            // the session is over: the debrief takes the terminal's place
            <section ref={setEndPanel} tabIndex={-1} aria-label="Разбор" className="panel min-h-0 flex-1 overflow-y-auto p-4 text-sm">
              <CollapsibleDoc doc={debrief} testId="debrief" />
            </section>
          ) : (
            <div ref={setEndPanel} tabIndex={-1} className="panel flex flex-1 items-center justify-center text-sm" style={{ color: "var(--muted)" }}>
              {over ? "Окружение удалено." : STATUS_LABEL[session.status]}
            </div>
          )
        )}
      </section>
      {scenario.reference && (
        <aside className="hidden xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto" data-testid="reference">
          <section className="panel p-4 text-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              📎 Справка
            </p>
            <CollapsibleDoc doc={scenario.reference} />
          </section>
        </aside>
      )}
    </div>
  );
}
