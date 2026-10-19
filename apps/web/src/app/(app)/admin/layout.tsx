import Link from "next/link";
import { requireAdminPage } from "@/lib/admin";

const TABS = [
  { href: "/admin", label: "Обзор" },
  { href: "/admin/users", label: "Пользователи" },
  { href: "/admin/sessions", label: "Сессии" },
  { href: "/admin/scenarios", label: "Сценарии" },
  { href: "/admin/submissions", label: "Заявки" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        <span className="mr-2 font-bold">Админка</span>
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--text)] no-underline hover:border-[var(--accent)]">
            {t.label}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
