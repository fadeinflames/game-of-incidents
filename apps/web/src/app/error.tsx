"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="panel p-6" role="alert" data-testid="error-page">
        <h1 className="mb-2 text-2xl font-bold">Что-то пошло не так</h1>
        <p className="mb-2 text-sm" style={{ color: "var(--muted)" }}>
          Страница не загрузилась. Обычно это временный сбой, например платформа обновляется. Попробуй обновить страницу через минуту.
        </p>
        {error.digest && (
          <p className="mb-4 text-xs" style={{ color: "var(--muted)" }}>
            Код ошибки: <code className="select-all">{error.digest}</code>
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            className="btn btn-primary"
            onClick={() =>
              // reset() alone re-renders with the cached server result; the refresh fetches the page again
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
          >
            Обновить
          </button>
          <Link href="/scenarios" className="btn no-underline">
            К сценариям
          </Link>
        </div>
      </div>
    </main>
  );
}
