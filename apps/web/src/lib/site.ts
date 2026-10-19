// The public address of the site: absolute URLs for link previews, robots.txt and sitemap.xml.
// Taken from the environment so that a deployment advertises its own address: SITE_URL, else https://WOM_DOMAIN, else the local development address.
const DEFAULT_SITE_URL = "http://localhost:3000";

/** the site address from the given environment: SITE_URL, else https://${WOM_DOMAIN}, else the local development address; no trailing slash */
export function resolveSiteUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = env.WOM_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  return DEFAULT_SITE_URL;
}

export const SITE_URL = resolveSiteUrl();

/** host name for places that show the address as text (the link preview card) */
export function siteHost(url: string = SITE_URL): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** pages a search engine may index; everything else is behind the login */
export const PUBLIC_PATHS = ["/"] as const;
