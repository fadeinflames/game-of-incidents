import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { ContactLink, NO_CONTACT_TEXT } from "@/components/contact-link";

export const metadata: Metadata = { title: "Регистрация" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/scenarios");
  if ((process.env.REGISTRATION_ENABLED ?? "true").toLowerCase() === "false") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
        <h1 className="mb-2 text-2xl font-bold">Регистрация закрыта</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Аккаунты выдаёт администратор. <Link href="/login">Войти</Link> <ContactLink fallback={NO_CONTACT_TEXT} />
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <div className="mb-6 flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-lg font-extrabold text-[#1a1000] shadow-[0_8px_24px_-6px_rgba(240,180,41,0.8)]"
          style={{ background: "linear-gradient(135deg, #ffc94d, #fb923c)" }}
        >
          !
        </span>
        <div>
          <h1 className="text-2xl font-extrabold leading-tight">Регистрация</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Логин и пароль, почта не нужна
          </p>
        </div>
      </div>
      <AuthForm mode="register" />
      <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
        Уже есть аккаунт? <Link href="/login">Войти</Link> · <Link href="/">О платформе</Link>
      </p>
      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        Почта не нужна: только логин и пароль. Восстановить забытый пароль сам не сможешь, новый выдаёт администратор, так что сохрани пароль в менеджере паролей. Аккаунт, которым не пользуются {process.env.INACTIVE_ACCOUNT_DAYS ?? 7} дней, отключается автоматически; чтобы
        вернуть его, напиши администратору. <ContactLink fallback={NO_CONTACT_TEXT} />
      </p>
    </main>
  );
}
