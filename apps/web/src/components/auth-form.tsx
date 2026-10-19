"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { postJson } from "@/lib/post-json";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // set after hydration: before that a submit would be a native form post (never a GET with the password in the URL)
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const payload =
      mode === "login"
        ? { identity: form.get("identity"), password: form.get("password") }
        : { username: form.get("username"), password: form.get("password") };
    const r = await postJson(`/api/auth/${mode}`, payload);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    router.push("/scenarios");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} method="post" className="panel flex flex-col gap-3 p-5 shadow-[0_30px_80px_-40px_rgba(99,102,241,0.6)]" data-hydrated={hydrated ? "true" : "false"}>
      {mode === "login" ? (
        <label className="flex flex-col gap-1 text-sm">
          Имя пользователя
          <input name="identity" required autoComplete="username" className="input" />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          Имя пользователя
          <input name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" autoComplete="username" aria-describedby="auth-username-hint" className="input" />
          <span id="auth-username-hint" className="text-xs" style={{ color: "var(--muted)" }}>Латиница, цифры, точка, дефис. Почта не нужна.</span>
        </label>
      )}
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="auth-password">Пароль</label>
        <div className="relative">
          <input
            id="auth-password"
            name="password"
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            // a new password for the sign-up lets the password manager offer a generated one
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            aria-describedby={mode === "register" ? "auth-password-hint" : undefined}
            className="input w-full pr-24"
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs text-muted hover:text-fg"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
          >
            {showPassword ? "скрыть" : "показать"}
          </button>
        </div>
        {mode === "register" && (
          <span id="auth-password-hint" className="text-xs text-muted">
            Не короче 8 символов. Почты нет, пароль сам не восстановить: сохрани его в менеджере паролей.
          </span>
        )}
      </div>
      {error && (
        <p className="text-sm" style={{ color: "var(--bad)" }} role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary mt-2 justify-center" disabled={busy} type="submit">
        {mode === "login" ? "Войти" : "Создать аккаунт"}
      </button>
    </form>
  );
}
