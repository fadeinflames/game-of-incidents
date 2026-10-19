import Link from "next/link";
import { ContactLink } from "./contact-link";
import { LogoutButton } from "./logout-button";
import { NavHeight } from "./nav-height";
import { NavLinks } from "./nav-links";

export function AppNav({ username, role }: { username: string; role: string }) {
  const links = [
    { href: "/scenarios", label: "Сценарии" },
    { href: "/history", label: "История" },
    { href: "/author", label: "Автору" },
    ...(role === "admin" ? [{ href: "/admin", label: "Админка" }] : []),
  ];
  return (
    <header data-app-nav className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur">
      {/* wraps onto a second row on phones instead of overflowing the screen */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-wide text-[var(--text)] no-underline" title="О платформе">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[13px] font-extrabold text-[#1a1000] shadow-[0_4px_14px_-4px_rgba(240,180,41,0.8)]"
              style={{ background: "linear-gradient(135deg, #ffc94d, #fb923c)" }}
            >
              !
            </span>
            Game of Incidents
          </Link>
          <NavLinks links={links} />
        </nav>
        <div className="flex items-center gap-3 text-sm" style={{ color: "var(--muted)" }}>
          <ContactLink className="text-[var(--muted)] hover:text-[var(--text)]" />
          <span className="hidden sm:inline">{username}</span>
          <LogoutButton />
        </div>
      </div>
      <NavHeight />
    </header>
  );
}
