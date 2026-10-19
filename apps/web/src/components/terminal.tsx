"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_MIN_CONTRAST, TERMINAL_THEME } from "@/lib/terminal-theme";
import {
  closeReason,
  isDoubleEscape,
  MAX_RECONNECTS,
  nextAttempt,
  PING_INTERVAL_MS,
  pingUnanswered,
  reconnectDelayMs,
  shouldReconnect,
  statusText,
  tokenRefusalIsFinal,
  type LinkStatus,
} from "@/lib/terminal-link";

const SR_PREF_KEY = "wom.terminal.screenReader";

// a per-viewer convenience: where storage is blocked the terminal still works, in its default mode
function readScreenReaderPref(): boolean {
  try {
    return localStorage.getItem(SR_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

/** a dim line inside the terminal itself: it is what a screen reader in screen-reader mode reads out, and what stays in the scrollback */
const notice = (text: string) => `\r\n\x1b[33m[${text}]\x1b[0m\r\n`;

export function Terminal({ sessionId, wsBase, onExit }: { sessionId: string; wsBase: string; /** where the focus goes on a double Escape; returns false when it has nowhere to go */ onExit?: () => boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [attemptShown, setAttemptShown] = useState(0);
  const [screenReader, setScreenReader] = useState(false);

  // the link's own bookkeeping; none of it is rendered, so refs
  const attemptRef = useRef(0);
  // numbers the calls of connect(): a call that finds a newer one started while it waited for the token gives up
  const connectSeq = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedAt = useRef<number | null>(null);
  const lastFrameAt = useRef(0);
  const pingSentAt = useRef<number | null>(null);
  const lastEscape = useRef<number | null>(null);
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  });
  // ends whichever link is current: the heartbeat calls it for a link that went silent
  const dropRef = useRef<((code: number) => void) | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  // `auto`: a retry the terminal makes by itself; the button starts a fresh chain of attempts
  const connect = useCallback(
    async (auto = false) => {
      const term = termRef.current;
      if (!term) return;
      clearRetry();
      const seq = ++connectSeq.current;
      const stale = () => termRef.current !== term || connectSeq.current !== seq;
      if (!auto) {
        attemptRef.current = 0;
        setAttemptShown(0);
      }
      const previous = wsRef.current;
      wsRef.current = null; // its late events are ignored: they belong to a link that is gone
      previous?.close();
      setStatus(auto ? "reconnecting" : "connecting");

      // a failed attempt of the chain is retried with a growing pause, up to MAX_RECONNECTS in a row
      const retryLater = (livedMs: number) => {
        const n = nextAttempt(attemptRef.current, livedMs);
        if (n > MAX_RECONNECTS) {
          setStatus("disconnected");
          term.write(notice("не удалось восстановить связь, нажми «Переподключить»"));
          return;
        }
        attemptRef.current = n;
        setAttemptShown(n);
        setStatus("reconnecting");
        retryTimer.current = setTimeout(() => void connect(true), reconnectDelayMs(n, Math.random()));
      };

      let token: string;
      try {
        const r = await fetch(`/api/sessions/${sessionId}/terminal-token`, { method: "POST" });
        if (stale()) return; // the terminal was closed, or the button started a newer attempt, while the token was being fetched
        if (!r.ok) {
          // not signed in, or the session is no longer running: asking again will not help
          if (tokenRefusalIsFinal(r.status) || !auto) setStatus("error");
          else retryLater(0);
          return;
        }
        ({ token } = (await r.json()) as { token: string });
      } catch {
        if (stale()) return;
        if (auto) retryLater(0);
        else setStatus("error");
        return;
      }
      if (stale()) return; // no socket for a view that is gone
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${wsBase.replace(/^http/, "ws")}/ws/term/${sessionId}?token=${encodeURIComponent(token)}`);
      } catch {
        setStatus("error");
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      openedAt.current = null;

      // one place for every way a link ends (a close event, a ping nobody answered), whichever comes first
      const dropped = (code: number) => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        pingSentAt.current = null;
        try {
          ws.close();
        } catch {}
        const lived = openedAt.current === null ? 0 : Date.now() - openedAt.current;
        openedAt.current = null;
        if (!shouldReconnect(code)) {
          setStatus("disconnected");
          term.write(notice(closeReason(code)));
          return;
        }
        if (lived > 0) term.write(notice(closeReason(code) + ", переподключаемся"));
        retryLater(lived);
      };
      dropRef.current = dropped;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        openedAt.current = Date.now();
        lastFrameAt.current = Date.now();
        pingSentAt.current = null;
        setStatus("connected");
        fitRef.current?.fit();
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        term.focus();
        setTimeout(() => {
          fitRef.current?.fit();
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }, 250);
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        lastFrameAt.current = Date.now(); // a pong or output: either proves the link is alive
        if (typeof ev.data === "string") return; // control frames (pong)
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = (ev) => dropped(ev.code);
      // an error is always followed by a close with a code; that is where it is handled
      ws.onerror = () => {};
    },
    [sessionId, wsBase, clearRetry],
  );

  useEffect(() => {
    let disposed = false;
    // assigned inside the async setup, released by the synchronous cleanup below (a cleanup returned from the async function would be dropped)
    let ro: ResizeObserver | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let refit: (() => void) | null = null;
    (async () => {
      const [{ Terminal: XTerminal }, { FitAddon: Fit }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      // the labels xterm gives the screen reader are English by default
      XTerminal.strings.promptLabel = "Ввод в терминал. Чтобы выйти из терминала, дважды нажми Escape";
      XTerminal.strings.tooMuchOutput = "Слишком много вывода, чтобы зачитать его целиком";
      const term = new XTerminal({
        cursorBlink: true,
        fontSize: 14,
        // the stack of the brief's code blocks (globals.css), so the two read alike
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, Consolas, monospace",
        theme: TERMINAL_THEME,
        // whatever a program draws in 256 or true colour is lifted to the same contrast as the palette
        minimumContrastRatio: TERMINAL_MIN_CONTRAST,
        scrollback: 5000, // long `describe` / `logs` outputs stay reachable
        // off by default (it costs speed); the person switches it on in the title bar
        screenReaderMode: readScreenReaderPref(),
      });
      const fit = new Fit();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;
      // Tab belongs to the shell, so the keyboard needs another way out (WCAG 2.1.2): a double Escape. The first Escape
      // still reaches the shell (vim and readline use it), the second one is swallowed and moves the focus away.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown" || ev.key !== "Escape") return true;
        const now = Date.now();
        if (!isDoubleEscape(lastEscape.current, now)) {
          lastEscape.current = now;
          return true;
        }
        lastEscape.current = null;
        if (!onExitRef.current?.()) exitRef.current?.focus();
        return false;
      });
      // the first fit may run with a fallback font: measure again once fonts are in and after layout settles
      refit = () => {
        try {
          fit.fit();
        } catch {}
      };
      document.fonts?.ready.then(refit).catch(() => {});
      setTimeout(refit, 300);
      window.addEventListener("resize", refit);
      term.onData((data) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
      });
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      // fit only when the host box actually changed: xterm re-rendering must not re-trigger the observer
      let last = { w: 0, h: 0 };
      ro = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (!box) return;
        const w = Math.round(box.width);
        const h = Math.round(box.height);
        if (w === last.w && h === last.h) return;
        last = { w, h };
        fit.fit();
      });
      ro.observe(hostRef.current);
      // heartbeat: a ping every interval; a link whose previous ping got no answer at all is dropped and retried
      ping = setInterval(() => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) return;
        if (pingUnanswered(pingSentAt.current, lastFrameAt.current)) {
          dropRef.current?.(1006);
          return;
        }
        pingSentAt.current = Date.now();
        ws.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
      await connect();
    })();
    return () => {
      disposed = true;
      clearRetry();
      ro?.disconnect();
      if (ping) clearInterval(ping);
      if (refit) window.removeEventListener("resize", refit);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [connect, clearRetry]);

  // the stored choice reaches the state after hydration, the choice itself reaches the running terminal
  useEffect(() => setScreenReader(readScreenReaderPref()), []);
  useEffect(() => {
    if (termRef.current) termRef.current.options.screenReaderMode = screenReader;
  }, [screenReader]);
  const toggleScreenReader = () => {
    const next = !screenReader;
    setScreenReader(next);
    try {
      localStorage.setItem(SR_PREF_KEY, next ? "1" : "0");
    } catch {}
    termRef.current?.focus();
  };

  const retrying = status === "reconnecting" || status === "connecting";
  return (
    <div className="panel flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs" style={{ color: "var(--muted)" }}>
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          </span>
          терминал ·
          <span
            aria-hidden="true"
            className={"h-2 w-2 shrink-0 rounded-full " + (retrying ? "animate-pulse" : "")}
            style={{ background: status === "connected" ? "var(--ok)" : retrying ? "var(--accent)" : "var(--bad)" }}
          />
          <span data-testid="terminal-status" role="status">{statusText(status, attemptShown)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="btn px-2 py-0.5 text-xs"
            aria-pressed={screenReader}
            onClick={toggleScreenReader}
            title="Выводит текст терминала в виде, который читает скринридер. Работает медленнее"
            data-testid="terminal-sr"
          >
            Режим для скринридера
          </button>
          {status !== "connected" && status !== "connecting" && (
            <button className="btn px-2 py-0.5 text-xs" onClick={() => void connect()}>
              Переподключить
            </button>
          )}
        </span>
      </div>
      <div ref={hostRef} className="min-h-[460px] flex-1 bg-inset p-2 lg:min-h-0" data-testid="terminal" />
      <div ref={exitRef} tabIndex={-1} className="border-t border-[var(--border)] px-3 py-1 text-[11px]" style={{ color: "var(--muted)" }}>
        Tab в терминале уходит в оболочку. Чтобы выйти с клавиатуры, дважды нажми Esc.
      </div>
    </div>
  );
}
