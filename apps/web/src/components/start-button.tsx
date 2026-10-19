"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson, POST_TIMEOUT_MS } from "@/lib/post-json";

export function StartButton({ scenarioId }: { scenarioId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const r = await postJson("/api/sessions", { scenarioId }, { timeoutMs: POST_TIMEOUT_MS.start });
    if (!r.ok) {
      setBusy(false);
      setError(r.error);
      return;
    }
    // the button stays busy while the router navigates: a second click would start a second stand
    router.push(`/sessions/${r.data.id}`);
  }

  return (
    <div className="flex flex-col gap-2">
      <button className="btn btn-primary w-full justify-center py-3 text-base" onClick={start} disabled={busy} data-testid="start-session">
        {busy ? "Поднимаем окружение…" : "▶ Запустить"}
      </button>
      {error && (
        <p className="text-sm" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
