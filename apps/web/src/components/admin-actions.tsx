"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson, POST_TIMEOUT_MS } from "@/lib/post-json";

/** one POST to an admin API route, then the page re-renders on the server */
export function AdminAction({
  url,
  label,
  busyLabel,
  confirm: confirmText,
  primary,
  testId,
}: {
  url: string;
  label: string;
  busyLabel?: string;
  confirm?: string;
  primary?: boolean;
  testId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      // stopping a session can wait for a cluster to be destroyed
      const r = await postJson(url, {}, { timeoutMs: POST_TIMEOUT_MS.stop });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // a partial success (the account is disabled, but a stand did not stop) is reported instead of hidden
      if (typeof r.data.warning === "string") setError(r.data.warning);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className={`btn px-2.5 py-1 text-xs ${primary ? "btn-primary" : ""}`} onClick={run} disabled={busy} data-testid={testId}>
        {busy ? (busyLabel ?? "…") : label}
      </button>
      {error && (
        <span className="text-xs" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** password reset: the one-time password is shown once, right here, and never logged */
export function ResetPassword({ userId, username }: { userId: string; username: string }) {
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!window.confirm(`Сбросить пароль пользователю ${username}? Его текущие входы завершатся.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ password?: string }>(`/api/admin/users/${userId}/reset-password`);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPassword(r.data.password ?? null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button className="btn px-2.5 py-1 text-xs" onClick={run} disabled={busy}>
        {busy ? "…" : "Сбросить пароль"}
      </button>
      {password && (
        <span className="text-xs">
          новый пароль: <code className="rounded bg-inset px-1.5 py-0.5 select-all">{password}</code> (показан один раз)
        </span>
      )}
      {error && (
        <span className="text-xs" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
