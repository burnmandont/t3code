import { isPublicFaviconHost } from "~/browser/browserTargetResolver";

/**
 * Favicon helpers for the preview tab strip.
 *
 * Hosted deployments can disable the third-party favicon provider with
 * `VITE_REMOTE_FAVICONS=0`. Callers should always render a `<Globe />`
 * fallback when this returns null or the remote request fails.
 */
const FAVICON_PROVIDER = "https://www.google.com/s2/favicons";

export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (import.meta.env.VITE_REMOTE_FAVICONS === "0") return null;
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.host) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPublicFaviconHost(url.hostname)) return null;
    return `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.host)}&sz=${size}`;
  } catch {
    return null;
  }
}
