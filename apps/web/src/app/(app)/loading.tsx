// Shown while a server page of the signed-in area is being prepared (the session page waits for the orchestrator).
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <span className="sr-only">Загружаем…</span>
      <div className="h-8 w-56 animate-pulse rounded-md bg-[var(--panel)]" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel h-40 animate-pulse" />
        <div className="panel h-40 animate-pulse" />
      </div>
    </div>
  );
}
