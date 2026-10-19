"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { postJson, POST_TIMEOUT_MS } from "@/lib/post-json";

/** stops every active session; the confirmation is a step on the page itself, not window.confirm */
export function KillAllSessions({ active }: { active: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ killed: number; failed: number } | null>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // The question appears in place of the button that was pressed: the focus goes to the safe answer (Cancel), and back to
  // the button when the question is closed. Escape is "no".
  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (wasAsking.current) openRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      // the server stops the sessions a few at a time, each can take tens of seconds
      const r = await postJson("/api/admin/sessions/kill-all", {}, { timeoutMs: 10 * 60_000 });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone({ killed: Number(r.data.killed) || 0, failed: Number(r.data.failed) || 0 });
      setAsking(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2" data-testid="kill-all">
      {!asking ? (
        <button
          ref={openRef}
          className="btn px-3 py-1 text-xs"
          style={{ color: "var(--bad)" }}
          disabled={active === 0}
          onClick={() => {
            setDone(null);
            setAsking(true);
          }}
          data-testid="kill-all-open"
        >
          Завершить все сессии
        </button>
      ) : (
        <div
          className="panel max-w-sm p-3 text-sm"
          role="alertdialog"
          aria-labelledby="kill-all-question"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) setAsking(false);
          }}
        >
          <p id="kill-all-question" className="mb-3">
            Остановить все активные сессии ({active})? Стенды всех пользователей будут удалены, отменить это нельзя.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn px-3 py-1 text-xs" style={{ color: "var(--bad)" }} onClick={run} disabled={busy} data-testid="kill-all-confirm">
              {busy ? "Завершаем…" : "Да, завершить все"}
            </button>
            <button ref={cancelRef} className="btn px-3 py-1 text-xs" onClick={() => setAsking(false)} disabled={busy}>
              Отмена
            </button>
          </div>
        </div>
      )}
      {done !== null && (
        <span className="text-xs" style={{ color: "var(--muted)" }} role="status" data-testid="kill-all-result">
          Завершено сессий: {done.killed}
          {done.failed > 0 && `, не удалось: ${done.failed}`}
        </span>
      )}
      {error && (
        <span className="text-xs" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
