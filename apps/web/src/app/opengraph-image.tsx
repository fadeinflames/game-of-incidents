// Link preview card (og:image). Uses only the font bundled with next/og (it covers Cyrillic), so rendering needs no network.
import { ImageResponse } from "next/og";
import { SITE_URL, siteHost } from "@/lib/site";

export const alt = "Game of Incidents: тренажёр инцидентов с живыми окружениями";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "#0f1115",
          color: "#e6e8ee",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: 30, letterSpacing: 6, color: "#f0b429" }}>ТРЕНАЖЁР ИНЦИДЕНТОВ</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 104, lineHeight: 1.05, fontWeight: 700 }}>Game of Incidents</div>
          <div style={{ display: "flex", marginTop: 28, fontSize: 34, lineHeight: 1.35, color: "#9aa3b2" }}>
            Живые окружения: сломанный Linux-хост или кластер Kubernetes, терминал в браузере, проверка результата и разбор
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 30 }}>
          <div
            style={{
              display: "flex",
              padding: "14px 22px",
              borderRadius: 12,
              border: "2px solid #2a2f3a",
              background: "#0b0d12",
              color: "#3ecf8e",
            }}
          >
            oncall@prod:~$ systemctl status nginx
          </div>
          <div style={{ display: "flex", color: "#9aa3b2" }}>{siteHost(SITE_URL)}</div>
        </div>
      </div>
    ),
    size,
  );
}
