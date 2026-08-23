export function isLoopbackHttpHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function normalizeSecureRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const isLoopbackHttp = url.protocol === "http:" && isLoopbackHttpHostname(url.hostname);
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/+$/u.test(url.pathname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isSecureRelayUrl(value: string): boolean {
  return normalizeSecureRelayUrl(value) !== null;
}
