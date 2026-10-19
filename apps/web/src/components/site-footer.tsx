// Footer of the landing and of the signed-in pages: the name, where the game came from and the few links people look for.
import Link from "next/link";
import { ContactLink } from "./contact-link";

export function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="mt-10 grid gap-6 border-t border-[var(--border)] pt-6 text-sm sm:grid-cols-[1.4fr_1fr]" style={{ color: "var(--muted)" }}>
      <div>
        <p className="mb-1 flex items-center gap-2 font-bold text-[var(--text)]">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-md text-xs font-extrabold text-[#1a1000]"
            style={{ background: "linear-gradient(135deg, #ffc94d, #fb923c)" }}
          >
            !
          </span>
          Game of Incidents
        </p>
        <p className="max-w-md text-xs leading-relaxed">
          Тренажёр инцидентов с живыми окружениями. Игра выросла из текстовой Wheel of Misfortune («колесо неудач»), где ведущий рассказывает, что видит дежурный.
        </p>
        <p className="mt-3 text-xs">© 2026 Maxim Gusev · Game of Incidents</p>
      </div>
      <nav aria-label="Ссылки внизу страницы" className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs content-start">
        <Link href="/scenarios" className="text-[var(--muted)] hover:text-[var(--text)]">
          Сценарии
        </Link>
        <Link href="/author" className="text-[var(--muted)] hover:text-[var(--text)]">
          Автору
        </Link>
        {signedIn ? (
          <Link href="/history" className="text-[var(--muted)] hover:text-[var(--text)]">
            История
          </Link>
        ) : (
          <>
            <Link href="/login" className="text-[var(--muted)] hover:text-[var(--text)]">
              Войти
            </Link>
            <Link href="/register" className="text-[var(--muted)] hover:text-[var(--text)]">
              Создать аккаунт
            </Link>
          </>
        )}
        <ContactLink className="text-[var(--muted)] hover:text-[var(--text)]" />
      </nav>
    </footer>
  );
}
