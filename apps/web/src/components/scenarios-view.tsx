"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DIFFICULTY } from "@/lib/labels";
import { DIFFICULTY_TONE, KIND_TONE, TUTORIAL_TONE, tone } from "@/lib/tones";
import { ProgressBadge, type Progress } from "./progress-badge";
import { Wheel } from "./wheel";

export type ScenarioCard = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  type: string;
  difficulty: "JUNIOR" | "MIDDLE" | "SENIOR";
  durationMin: number;
  tags: string[];
  kind: "container" | "kubernetes";
  /** declared usual startup time; heavy stacks (extra CNI, ingress, Prometheus…) say so on the card */
  startupSec: number | null;
  /** this person's own result; null when never finished an attempt */
  progress: Progress | null;
};

const KIND: Record<ScenarioCard["kind"], string> = { container: "Linux‑хост", kubernetes: "Kubernetes" };
type Format = "tutorial" | "regular";
const FORMAT: Record<Format, string> = { tutorial: "🎓 Учебные", regular: "Обычные" };
const formatOf = (s: ScenarioCard): Format => (s.tags.includes("tutorial") ? "tutorial" : "regular");

type Tab = "pick" | "random";

const LEVELS = ["JUNIOR", "MIDDLE", "SENIOR"] as const;
const LEVEL_NOTE: Record<(typeof LEVELS)[number], string> = {
  JUNIOR: "первые инциденты, у многих есть учебная версия",
  MIDDLE: "нужно связать несколько симптомов",
  SENIOR: "каскады, сеть и неочевидные причины",
};

type Capacity = { all: { active: number; max: number }; kubernetes: { active: number; max: number } };

export function ScenariosView({ scenarios, capacity }: { scenarios: ScenarioCard[]; capacity: Capacity | null }) {
  const [tab, setTab] = useState<Tab>("pick");
  const [difficulties, setDifficulties] = useState<Set<ScenarioCard["difficulty"]>>(new Set());
  const [kinds, setKinds] = useState<Set<ScenarioCard["kind"]>>(new Set());
  const [formats, setFormats] = useState<Set<Format>>(new Set());

  const pool = useMemo(
    () =>
      scenarios.filter(
        (s) =>
          (difficulties.size === 0 || difficulties.has(s.difficulty)) &&
          (kinds.size === 0 || kinds.has(s.kind)) &&
          (formats.size === 0 || formats.has(formatOf(s))),
      ),
    [scenarios, difficulties, kinds, formats],
  );

  const solvedCount = useMemo(() => scenarios.filter((s) => s.progress?.state === "solved").length, [scenarios]);
  const hasTutorials = useMemo(() => scenarios.some((s) => formatOf(s) === "tutorial"), [scenarios]);

  // the first-visit shortcut: the beginner view is the same filter a person could set by hand
  const showBeginnerView = () => {
    setTab("pick");
    setDifficulties(new Set(["JUNIOR"]));
    setKinds(new Set());
    setFormats(new Set(["tutorial"]));
  };

  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">Сценарии</h1>
      <p className="mb-2 text-sm" style={{ color: "var(--muted)" }}>
        Выбери сценарий сам, отфильтруй по уровню и типу стенда или доверься случайному выбору. «Подробнее» открывает описание; стенд поднимается, только когда нажмёшь «Запустить» на странице сценария.
      </p>
      {hasTutorials && (
        <p className="mb-2 text-sm" style={{ color: "var(--muted)" }} data-testid="start-here">
          <strong style={{ color: "var(--text)" }}>С чего начать.</strong> В первый раз бери Junior с пометкой «учебный»: в нём этапы диагностики открываются по одному, и есть объяснения команд.{" "}
          <button type="button" className="underline" style={{ color: "var(--accent)" }} onClick={showBeginnerView} data-testid="start-here-apply">
            Показать учебные Junior
          </button>
        </p>
      )}
      <p className="mb-4 text-xs sm:hidden" style={{ color: "var(--muted)" }} data-testid="mobile-note">
        Терминал удобнее на компьютере: с телефона можно читать описания, а решать лучше за клавиатурой.
      </p>
      <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Как выбрать сценарий">
        <TabButton active={tab === "pick"} onClick={() => setTab("pick")} testId="tab-pick">
          Выбрать самому
        </TabButton>
        <TabButton active={tab === "random"} onClick={() => setTab("random")} testId="tab-random">
          Случайный сценарий
        </TabButton>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <span style={{ color: "var(--muted)" }}>Фильтр:</span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Уровень">
          {(["JUNIOR", "MIDDLE", "SENIOR"] as const).map((d) => (
            <Chip key={d} color={DIFFICULTY_TONE[d]} active={difficulties.has(d)} onClick={() => toggle(difficulties, d, setDifficulties)}>
              {DIFFICULTY[d]}
            </Chip>
          ))}
        </div>
        <span className="mx-1" style={{ color: "var(--border)" }} aria-hidden="true">
          |
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Тип стенда">
          {(["container", "kubernetes"] as const).map((k) => (
            <Chip key={k} color={KIND_TONE[k]} active={kinds.has(k)} onClick={() => toggle(kinds, k, setKinds)}>
              {KIND[k]}
            </Chip>
          ))}
        </div>
        <span className="mx-1" style={{ color: "var(--border)" }} aria-hidden="true">
          |
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Формат">
          {(["tutorial", "regular"] as const).map((f) => (
            <Chip key={f} active={formats.has(f)} onClick={() => toggle(formats, f, setFormats)} testId={`filter-${f}`}>
              {FORMAT[f]}
            </Chip>
          ))}
        </div>
        {/* the count changes with the filter: it is read out, so a screen-reader user hears what the filter did */}
        <span role="status" style={{ color: "var(--muted)" }}>
          {pool.length} из {scenarios.length}
        </span>
        <span style={{ color: solvedCount > 0 ? "var(--ok)" : "var(--muted)" }} data-testid="solved-count">
          · решено {solvedCount} из {scenarios.length}
        </span>
        {capacity && (
          <span className="ml-auto" style={{ color: capacity.kubernetes.active >= capacity.kubernetes.max ? "var(--bad)" : "var(--muted)" }} data-testid="capacity" title="Стенды поднимаются на одном сервере; если все слоты заняты, попробуй через несколько минут">
            занято: Kubernetes {capacity.kubernetes.active} из {capacity.kubernetes.max} · всего {capacity.all.active} из {capacity.all.max}
          </span>
        )}
      </div>

      {tab === "pick" ? (
        <div className="flex flex-col gap-8">
          {LEVELS.map((level) => {
            const group = pool.filter((s) => s.difficulty === level);
            if (group.length === 0) return null;
            return (
              <section key={level} aria-labelledby={`level-${level}`} data-testid={`level-${level}`}>
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1" style={tone(DIFFICULTY_TONE[level])}>
                  <h2 id={`level-${level}`} className="flex items-center gap-2 text-xl font-extrabold">
                    <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ background: "var(--tone)", boxShadow: "0 0 10px var(--tone)" }} />
                    {DIFFICULTY[level]}
                  </h2>
                  <span className="text-sm" style={{ color: "var(--muted)" }}>
                    {LEVEL_NOTE[level]}
                  </span>
                  <span className="pill ml-auto">{group.length}</span>
                </div>
                {/* role="list": the reset of list styles makes some screen readers drop the list */}
                <ul role="list" className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {group.map((s) => (
                    <li key={s.id} className="flex">
                      <ScenarioTile s={s} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {pool.length === 0 && <p style={{ color: "var(--muted)" }}>Под фильтр ничего не попало.</p>}
        </div>
      ) : (
        <Wheel scenarios={pool} render={(s) => <ScenarioTile s={s} />} />
      )}
    </div>
  );
}

function ScenarioTile({ s }: { s: ScenarioCard }) {
  return (
    <article className="panel tile flex w-full flex-col gap-3 p-5" style={tone(DIFFICULTY_TONE[s.difficulty])} data-testid={`scenario-${s.slug}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="pill pill-dot">{DIFFICULTY[s.difficulty]}</span>
        <span className="pill" style={tone(KIND_TONE[s.kind])}>
          {KIND[s.kind]}
        </span>
        {s.tags.includes("tutorial") && (
          <span className="pill" style={tone(TUTORIAL_TONE)} title="Бриф ведёт по диагностике шаг за шагом">
            🎓 учебный
          </span>
        )}
      </div>
      <h3 className="text-lg font-semibold leading-snug">
        <Link href={`/scenarios/${s.slug}`} style={{ color: "inherit", textDecoration: "none" }}>
          {s.title}
        </Link>
      </h3>
      {s.progress && (
        <p>
          <ProgressBadge progress={s.progress} />
        </p>
      )}
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        {s.summary}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
        <span>⏱ ~{s.durationMin} мин</span>
        {s.startupSec != null && s.startupSec >= 90 && (
          <>
            <span>·</span>
            <span title="Тяжёлый стенд: в кластере поднимаются дополнительные компоненты">⏳ старт ~{Math.round(s.startupSec / 60)} мин</span>
          </>
        )}
        {[...new Set(s.tags)]
          .filter((t) => t !== "tutorial")
          .map((t) => (
            <span key={t} className="rounded bg-inset px-1.5 py-0.5 text-[11px]">
              #{t}
            </span>
          ))}
      </div>
      <div className="mt-auto">
        <Link className="btn" href={`/scenarios/${s.slug}`} style={{ textDecoration: "none" }} data-testid="scenario-details">
          Подробнее<span className="sr-only">: {s.title}</span> <span aria-hidden="true">→</span>
        </Link>
      </div>
    </article>
  );
}

function TabButton({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      className="rounded-lg border px-4 py-2 text-sm font-semibold transition-colors hover:border-[var(--accent)]"
      style={{
        borderColor: active ? "var(--accent)" : "var(--border-strong)",
        background: active ? "linear-gradient(135deg, rgba(255,201,77,0.2), rgba(251,146,60,0.14))" : "var(--panel)",
        color: active ? "var(--accent)" : "var(--text)",
        boxShadow: active ? "0 6px 20px -10px rgba(240,180,41,0.8)" : undefined,
      }}
    >
      {active && <span aria-hidden="true">✓ </span>}
      {children}
    </button>
  );
}

function Chip({ active, onClick, children, testId, color = "var(--accent)" }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string; color?: string }) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      data-testid={testId}
      className="rounded-full border px-2.5 py-1 transition-colors hover:bg-white/5"
      style={{
        borderColor: active ? color : "var(--border-strong)",
        color: active ? color : "var(--text)",
        background: active ? `color-mix(in srgb, ${color} 14%, transparent)` : "transparent",
      }}
    >
      {/* the state is not carried by colour alone (WCAG 1.4.1); a screen reader gets it from aria-pressed */}
      {active && <span aria-hidden="true">✓ </span>}
      {children}
    </button>
  );
}
