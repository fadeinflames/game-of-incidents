import type { Metadata } from "next";

// sign-in and sign-up forms are service pages, not search results
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
