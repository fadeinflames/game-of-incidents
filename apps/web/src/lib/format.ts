// Dates are stored in UTC; the platform shows them in one fixed zone (WOM_TZ, default Europe/Moscow) regardless of
// where the container or the browser runs.
export const platformTimeZone = () => process.env.WOM_TZ ?? "Europe/Moscow";

const dt = () =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: platformTimeZone(), day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dt().format(typeof d === "string" ? new Date(d) : d);
}
