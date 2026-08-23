export const operatorRecoveryMessage =
  "Password sign-in is restricted to an approved operator network. Use a passkey on remote devices.";

export function passwordSignInErrorMessage(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return /^forbidden$/iu.test(error.message.trim()) ? operatorRecoveryMessage : error.message;
}

export function oauthContinuationUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const continuation = value as { readonly redirect?: unknown; readonly url?: unknown };
  return continuation.redirect === true &&
    typeof continuation.url === "string" &&
    continuation.url.length > 0
    ? continuation.url
    : null;
}
