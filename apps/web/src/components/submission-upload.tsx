"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson, POST_TIMEOUT_MS } from "@/lib/post-json";
import { archiveProblem } from "@/lib/upload-check";

/** `maxBytes`: the server's limit for an archive (ZIP_MAX_BYTES), passed in because this file runs in the browser */
export function SubmissionUpload({ maxBytes }: { maxBytes: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    // the server would refuse a large file only after receiving all of it
    const file = form.get("archive");
    const problem = file instanceof File ? archiveProblem(file, maxBytes) : null;
    if (problem) {
      setMsg({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson("/api/author/submissions", form, { timeoutMs: POST_TIMEOUT_MS.upload });
      if (!r.ok) {
        // every problem at once: the author fixes the archive in one go instead of one error per upload
        const issues = Array.isArray(r.data.issues) ? r.data.issues.filter((i: unknown): i is string => typeof i === "string") : [];
        setMsg({ ok: false, text: r.error, issues });
        return;
      }
      setMsg({ ok: true, text: r.data.status === "LINT_FAILED" ? "Архив принят, но в формате есть ошибки, см. заявку" : "Архив принят, формат в порядке. Заявка ждёт проверки модератором." });
      formEl.reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="panel flex flex-col gap-3 p-4" data-testid="submission-form">
      <label className="flex flex-col gap-1 text-sm">
        Zip‑архив папки сценария
        <input id="archive" name="archive" type="file" accept=".zip,application/zip" required className="text-sm" aria-describedby="archive-limit" />
        <span id="archive-limit" className="text-xs" style={{ color: "var(--muted)" }}>
          До {Math.round(maxBytes / 1024 / 1024)} МБ, внутри должен быть scenario.yaml.
        </span>
      </label>
      <button className="btn btn-primary self-start" disabled={busy} type="submit" data-testid="submission-submit">
        {busy ? "Загружаем…" : "Загрузить"}
      </button>
      {msg && (
        <div className="text-sm" style={{ color: msg.ok ? "var(--ok)" : "var(--bad)" }} role={msg.ok ? "status" : "alert"}>
          <p>{msg.text}</p>
          {msg.issues && msg.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5" data-testid="submission-issues">
              {msg.issues.map((i, k) => (
                <li key={k}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
