// Feedback channel: one link from the CONTACT_URL environment variable (a Telegram chat, a mailto: address).
// Server components only: the variable is read at request time and is not exposed to the client bundle.
import "server-only";

/** the configured contact link, or null when it is unset or is not an http(s) / mailto / tg link.
 *  `subject` is added to a mailto: link that has no query of its own (a chat link cannot carry a text). */
export function contactUrl(subject?: string): string | null {
  const url = process.env.CONTACT_URL?.trim();
  if (!url || !/^(https?:\/\/|mailto:|tg:)/i.test(url)) return null;
  return subject && /^mailto:/i.test(url) && !url.includes("?") ? `${url}?subject=${encodeURIComponent(subject)}` : url;
}

/** for places that send the reader to "write to the administrator": without a contact that advice is a dead end */
export const NO_CONTACT_TEXT = "Контакт для связи пока не настроен, попробуй зайти позже.";

/** renders nothing when CONTACT_URL is not configured, unless the place passes a `fallback` text for the reader */
export function ContactLink({ className, children = "Написать нам", fallback }: { className?: string; children?: React.ReactNode; fallback?: React.ReactNode }) {
  const url = contactUrl();
  if (!url) return fallback ? <span data-testid="contact-missing">{fallback}</span> : null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className={className} data-testid="contact-link">
      {children}
    </a>
  );
}
