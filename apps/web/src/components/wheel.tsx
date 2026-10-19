"use client";

// The Wheel of Misfortune: a spinning wheel that picks one scenario from the filtered pool (user story 2).
// The pick is made up front with crypto randomness; the animation just lands on it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Item = { id: string; title: string; difficulty: "JUNIOR" | "MIDDLE" | "SENIOR" };

// the wheel is drawn in a fixed 340 px coordinate space; the canvas backing store is scaled up for dense screens
const SIZE = 340;
const SEGMENTS = 8;

/** the colors come from the CSS tokens (globals.css), so the wheel follows the palette */
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return {
    segments: Array.from({ length: SEGMENTS }, (_, i) => get(`--wheel-${i + 1}`)),
    ink: get("--bg"),
    hub: get("--panel"),
    hubBorder: get("--border"),
  };
}

export function Wheel<T extends Item>({ scenarios, render }: { scenarios: T[]; render: (s: T) => React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [angle, setAngle] = useState(0); // radians, current rotation
  const [spinning, setSpinning] = useState(false);
  const [chosen, setChosen] = useState<T | null>(null);
  const raf = useRef<number | null>(null);
  // the state above lags a render behind a click: a double click would start two animations before `spinning` is true
  const busy = useRef(false);
  const palette = useRef<ReturnType<typeof readPalette> | null>(null);
  const n = scenarios.length;
  const seg = useMemo(() => (n ? (2 * Math.PI) / n : 0), [n]);

  // reset when the pool changes; a spin still running was aimed at the old pool, so it is cancelled, not allowed to land on a scenario the filter has just removed
  useEffect(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    busy.current = false;
    setSpinning(false);
    setChosen(null);
    setAngle(0);
  }, [scenarios]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    palette.current ??= readPalette();
    const { segments, ink, hub, hubBorder } = palette.current;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(SIZE * dpr)) {
      c.width = Math.round(SIZE * dpr);
      c.height = Math.round(SIZE * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = SIZE / 2;
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (!n) return;
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(angle);
    scenarios.forEach((s, i) => {
      const a0 = i * seg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 6, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = segments[i % segments.length];
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 3;
      ctx.stroke();
      // label along the segment's middle radius
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = ink;
      ctx.font = `600 ${n > 8 ? 12 : 14}px system-ui, sans-serif`;
      const label = s.title.length > 26 ? s.title.slice(0, 25) + "…" : s.title;
      ctx.fillText(label, r - 18, 0);
      ctx.restore();
    });
    ctx.restore();
    // hub
    ctx.beginPath();
    ctx.arc(r, r, 22, 0, 2 * Math.PI);
    ctx.fillStyle = hub;
    ctx.fill();
    ctx.strokeStyle = hubBorder;
    ctx.stroke();
  }, [angle, n, scenarios, seg]);

  useEffect(() => {
    draw();
  }, [draw]);

  const spin = () => {
    if (busy.current || !n) return;
    busy.current = true;
    setChosen(null);
    const idx = new Uint32Array(1);
    crypto.getRandomValues(idx);
    const pick = idx[0] % n;
    // pointer sits at the top (-90°); segment `pick` must end centred under it
    const target = -Math.PI / 2 - (pick * seg + seg / 2);
    // prefers-reduced-motion: no long spinning, the wheel just turns to the pick
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const turns = 5 + Math.floor(Math.random() * 3);
    const start = angle;
    // spin clockwise several full turns then land; calm: the equivalent landing angle nearest to where the wheel stands
    const end = calm ? target + 2 * Math.PI * Math.round((start - target) / (2 * Math.PI)) : target - 2 * Math.PI * turns;
    const duration = calm ? 600 : 3800 + Math.random() * 800;
    const t0 = performance.now();
    setSpinning(true);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // cubic ease-out
      setAngle(start + (end - start) * eased);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else {
        raf.current = null;
        busy.current = false;
        setSpinning(false);
        setChosen(scenarios[pick]);
      }
    };
    raf.current = requestAnimationFrame(step);
  };

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
  }, []);

  if (!n) return <p style={{ color: "var(--muted)" }}>Под фильтр ничего не попало, колесу нечего крутить.</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <div className="flex flex-col items-center gap-4">
        <div className="relative aspect-square w-full" style={{ maxWidth: SIZE }}>
          <div className="absolute left-1/2 top-0 z-10" style={{ transform: "translate(-50%, -6px)", width: 0, height: 0, borderLeft: "12px solid transparent", borderRight: "12px solid transparent", borderTop: "22px solid var(--text)" }} />
          <canvas
            ref={canvasRef}
            width={SIZE}
            height={SIZE}
            className="h-full w-full"
            role="img"
            aria-label={`Колесо сценариев: ${n} ${n === 1 ? "сегмент" : n < 5 ? "сегмента" : "сегментов"}. Результат прочитают под колесом.`}
            data-testid="wheel"
          />
        </div>
        {/* the canvas says nothing to a screen reader: the pick is announced here */}
        <p className="sr-only" role="status">
          {chosen ? `Колесо выбрало: ${chosen.title}` : ""}
        </p>
        <button className="btn btn-primary px-6" onClick={spin} disabled={spinning} data-testid="spin">
          {spinning ? "Крутится…" : chosen ? "Крутить ещё раз" : "Крутить колесо"}
        </button>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          В барабане {n} {n === 1 ? "сценарий" : n < 5 ? "сценария" : "сценариев"}
        </p>
      </div>
      <div className="flex items-center">
        {chosen ? (
          <div className="w-full" data-testid="wheel-result">
            <h2 className="mb-3 text-sm" style={{ color: "var(--muted)" }}>
              Колесо выбрало:
            </h2>
            {render(chosen)}
          </div>
        ) : (
          <div className="panel w-full p-6 text-sm" style={{ color: "var(--muted)" }}>
            {spinning ? "Судьба решает…" : "Нажми «Крутить колесо». Сценарий выбирается случайно из отфильтрованного набора."}
          </div>
        )}
      </div>
    </div>
  );
}
