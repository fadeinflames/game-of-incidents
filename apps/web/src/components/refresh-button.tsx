"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** re-renders the current server page; for the pages that say "the platform did not answer, try again" */
export function RefreshButton({ label = "Обновить" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button className="btn" disabled={pending} onClick={() => startTransition(() => router.refresh())} data-testid="refresh">
      {pending ? "Обновляем…" : label}
    </button>
  );
}
