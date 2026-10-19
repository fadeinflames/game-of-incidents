import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { ContactLink, NO_CONTACT_TEXT } from "@/components/contact-link";

export const metadata: Metadata = { title: "Вход" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/scenarios");
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
          <h1 className="text-2xl font-extrabold leading-tight">Game of Incidents</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Тренажёр инцидентов с живыми окружениями
          </p>
        </div>
      </div>
      <AuthForm mode="login" />
      {(process.env.REGISTRATION_ENABLED ?? "true").toLowerCase() !== "false" && (
        <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
          Нет аккаунта? <Link href="/register">Зарегистрироваться</Link> · <Link href="/">О платформе</Link>
        </p>
      )}
      <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
        Почты у платформы нет: аккаунт — только логин и пароль, поэтому забытый пароль сам не восстановишь, новый выдаёт администратор. Аккаунты, которыми не пользовались {process.env.INACTIVE_ACCOUNT_DAYS ?? 7} дней,
        отключаются автоматически; если тебя не пускает, напиши администратору, и аккаунт включат обратно.{" "}
        <ContactLink fallback={NO_CONTACT_TEXT} />
      </p>
    </main>
  );
}
