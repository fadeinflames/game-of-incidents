import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  // absolute URLs for og:image and og:url: link previews (Telegram) ignore relative ones
  metadataBase: new URL(SITE_URL),
  title: { default: "Game of Incidents", template: "%s · Game of Incidents" },
  description: "Game of Incidents: тренажёр инцидентов с живыми окружениями",
  openGraph: { type: "website", locale: "ru_RU", siteName: "Game of Incidents", url: "/" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
