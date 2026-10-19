"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/post-json";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson("/api/auth/logout");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push("/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn px-3 py-1 text-xs" onClick={logout} disabled={busy}>
        Выйти
      </button>
      {error && (
        <span className="text-xs" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </span>
      )}
    </>
  );
}
