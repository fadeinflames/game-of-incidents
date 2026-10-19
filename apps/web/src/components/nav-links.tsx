"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** section links of the app header; the current section is highlighted and marked with aria-current */
export function NavLinks({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <>
      {links.map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-md px-2.5 py-1 no-underline transition-colors " +
              (active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-white/5 hover:text-[var(--text)]")
            }
          >
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
