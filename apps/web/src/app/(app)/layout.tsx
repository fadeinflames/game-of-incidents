import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { AppNav } from "@/components/app-nav";
import { SiteFooter } from "@/components/site-footer";

// everything under the signed-in area is closed to search engines (robots.txt closes it as well)
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <>
      <AppNav username={user.username} role={user.role} />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <div className="mx-auto max-w-6xl px-4 pb-10">
        <SiteFooter signedIn />
      </div>
    </>
  );
}
