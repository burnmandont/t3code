import { faviconUrlForOrigin as sharedFaviconUrlForOrigin } from "@t3tools/shared/favicon";

/**
 * Favicon helpers for the preview tab strip.
 *
 * Hosted deployments can disable the third-party favicon provider with
 * `VITE_REMOTE_FAVICONS=0`. Callers should always render a `<Globe />`
 * fallback when this returns null or the remote request fails.
 */
export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (import.meta.env.VITE_REMOTE_FAVICONS === "0") return null;
  return sharedFaviconUrlForOrigin(rawUrl, size);
}
