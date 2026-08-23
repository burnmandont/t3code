export interface PublicClientProvisioningConfiguration {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly postLogoutRedirectUris: ReadonlyArray<string>;
  readonly skipConsent: boolean;
}

const publicClientRedirectSchemes = new Set(["t3code:", "t3code-dev:"]);
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isAllowedPublicClientUri(parsed: URL): boolean {
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") return loopbackHostnames.has(parsed.hostname);
  return publicClientRedirectSchemes.has(parsed.protocol);
}

function parseUris(
  name: string,
  value: string | undefined,
  required: boolean,
): ReadonlyArray<string> {
  const uris = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (required && uris.length === 0) throw new Error(`${name} is required.`);
  for (const uri of uris) {
    const parsed = new URL(uri);
    if (!isAllowedPublicClientUri(parsed)) {
      throw new Error(`${name} contains an unsafe redirect URI.`);
    }
  }
  return uris;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

export function loadPublicClientProvisioningConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PublicClientProvisioningConfiguration {
  const clientId = environment.T3_ACCOUNT_CLIENT_ID?.trim() || "t3-code";
  return {
    clientId,
    name: environment.T3_ACCOUNT_CLIENT_NAME?.trim() || "Sovereign",
    redirectUris: parseUris(
      "T3_ACCOUNT_CLIENT_REDIRECT_URIS",
      environment.T3_ACCOUNT_CLIENT_REDIRECT_URIS,
      true,
    ),
    postLogoutRedirectUris: parseUris(
      "T3_ACCOUNT_CLIENT_POST_LOGOUT_REDIRECT_URIS",
      environment.T3_ACCOUNT_CLIENT_POST_LOGOUT_REDIRECT_URIS,
      false,
    ),
    skipConsent: parseBoolean(
      "T3_ACCOUNT_CLIENT_SKIP_CONSENT",
      environment.T3_ACCOUNT_CLIENT_SKIP_CONSENT,
      true,
    ),
  };
}
