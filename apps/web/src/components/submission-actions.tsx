"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { postJson } from "@/lib/post-json";

export function SubmissionActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // while a test runs on the orchestrator, refresh the page every few seconds
  useEffect(() => {
    if (status !== "TESTING") return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [status, router]);

  async function act(action: string, body?: unknown) {
    setBusy(action);
    setError(null);
    try {
      const r = await postJson(`/api/admin/submissions/${id}/${action}`, body ?? {});
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const canTest = ["UPLOADED", "PASSED", "FAILED"].includes(status);
  const canApprove = status === "PASSED";
  const canReject = !["APPROVED", "REJECTED"].includes(status);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {canTest && (
        <button className="btn" onClick={() => act("test")} disabled={busy !== null} data-testid="submission-test" title="Соберёт образ из архива и выполнит его скрипты на этом сервере: сначала просмотри файлы выше">
          {busy === "test" ? "Ставим в очередь…" : status === "UPLOADED" ? "Проверить (сборка + регресс)" : "Проверить ещё раз"}
        </button>
      )}
      {status === "TESTING" && (
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          проверяется, страница обновится сама
        </span>
      )}
      {canApprove && (
        <button className="btn btn-primary" onClick={() => act("approve")} disabled={busy !== null} data-testid="submission-approve">
          Опубликовать
        </button>
      )}
      {canReject && (
        <>
          <input
            id={`note-${id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Комментарий автору"
            placeholder="комментарий автору"
            className="input min-w-[220px] flex-1 px-2 py-1 text-sm"
          />
          <button className="btn" onClick={() => act("reject", { note })} disabled={busy !== null || !note.trim()} data-testid="submission-reject">
            Отклонить
          </button>
        </>
      )}
      {error && (
        <span className="text-sm" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
