import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="panel p-6" data-testid="not-found">
        <h1 className="mb-2 text-2xl font-bold">Такой страницы нет</h1>
        <p className="mb-5 text-sm" style={{ color: "var(--muted)" }}>
          Ссылка устарела или в ней опечатка. Сессия или сценарий могли быть удалены.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/scenarios" className="btn btn-primary no-underline">
            К сценариям
          </Link>
          <Link href="/" className="btn no-underline">
            На главную
          </Link>
        </div>
      </div>
    </main>
  );
}
