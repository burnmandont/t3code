import {
  buildConnectOAuthAuthorizeUrl,
  connectCallbackUrl,
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  SOVEREIGN_CONNECT_OAUTH_SCOPES,
  type ConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { isLoopbackHttpHostname } from "@t3tools/shared/relayUrl";

import { configuredHostedAppUrl, isHostedStaticApp } from "../hostedPairing";
import { resolveCloudPublicConfig, trimNonEmpty } from "./publicConfig";

const CONNECT_CLI_AUTH_STATE_STORAGE_KEY = "t3code-connect-cli-auth-state";

export function resolveConnectCliOAuthClientId(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID as string | undefined);
}

export interface ConnectCliOAuthConfig {
  readonly provider: "clerk" | "sovereign";
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly resource?: string;
}

function resolveSovereignIssuer(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLoopbackHttp = url.protocol === "http:" && isLoopbackHttpHostname(url.hostname);
    if ((url.protocol !== "https:" && !isLoopbackHttp) || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function resolveConnectCliOAuthConfig(): ConnectCliOAuthConfig | null {
  const oauthIssuerValue = trimNonEmpty(
    import.meta.env.VITE_T3CODE_OAUTH_ISSUER as string | undefined,
  );
  const oauthIssuer = resolveSovereignIssuer(oauthIssuerValue);
  const oauthClientId = trimNonEmpty(
    import.meta.env.VITE_T3CODE_OAUTH_CLIENT_ID as string | undefined,
  );
  const oauthResource = trimNonEmpty(
    import.meta.env.VITE_T3CODE_OAUTH_RESOURCE as string | undefined,
  );
  if (oauthIssuerValue || oauthClientId || oauthResource) {
    if (!oauthIssuer || !oauthClientId || !oauthResource) return null;
    return {
      provider: "sovereign",
      authorizationEndpoint: `${oauthIssuer}/oauth2/authorize`,
      clientId: oauthClientId,
      scopes: SOVEREIGN_CONNECT_OAUTH_SCOPES,
      resource: oauthResource,
    };
  }

  const { clerkPublishableKey } = resolveCloudPublicConfig();
  const clerkClientId = resolveConnectCliOAuthClientId();
  if (!clerkPublishableKey || !clerkClientId) return null;
  return {
    provider: "clerk",
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey)}/oauth/authorize`,
    clientId: clerkClientId,
    scopes: CONNECT_OAUTH_SCOPES,
  };
}

export function hasConnectCliAuthConfig(): boolean {
  return resolveConnectCliOAuthConfig() !== null;
}

/**
 * Gate for the /connect routes: the CLI handshake only exists on the hosted
 * deployment (the same bundle ships inside local instances) and needs the
 * Clerk CLI OAuth client configured at build time.
 */
export function connectCliAuthRoutesEnabled(): boolean {
  return isHostedStaticApp() && hasConnectCliAuthConfig();
}

/**
 * Builds the configured provider's authorize URL for a CLI-initiated request.
 * Loopback requests return directly to the waiting CLI; headless requests use
 * the hosted callback page so the user can copy the one-time code.
 */
export function buildConnectCliOAuthAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const config = resolveConnectCliOAuthConfig();
  if (!config) return null;
  return buildConnectOAuthAuthorizeUrl({
    authorizationEndpoint: config.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri:
      request.loopbackPort === undefined
        ? connectCallbackUrl(configuredHostedAppUrl())
        : connectLoopbackRedirectUri(request.loopbackPort),
    scopes: config.scopes,
    state: request.state,
    challenge: request.challenge,
  });
}

/** @deprecated Use buildConnectCliOAuthAuthorizeUrl. */
export const buildConnectCliClerkAuthorizeUrl = buildConnectCliOAuthAuthorizeUrl;

/**
 * Where the provider sends the browser once sign-in on /connect completes.
 * It has to be the authorize endpoint rather than this page: /connect carries
 * the CLI request in its fragment, so navigating back to the same URL is a
 * same-document fragment navigation the browser never reloads — and Clerk
 * treats any post-sign-in navigation as a page unload and skips the state emit
 * that would otherwise re-render the surface, so the session never arrives
 * either. Falls back to the current URL when the authorize URL cannot be
 * built, which only happens on a deployment without the CLI OAuth config.
 */
export function connectCliSignInRedirectUrl(
  request: ConnectAuthorizeRequest,
  currentHref: string,
): string {
  return buildConnectCliOAuthAuthorizeUrl(request) ?? currentHref;
}

export function rememberConnectCliAuthState(state: string): void {
  try {
    window.sessionStorage.setItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY, state);
  } catch {
    // Session storage can be unavailable (e.g. blocked). The callback page
    // then falls back to trusting the state Clerk echoed back.
  }
}

/**
 * Read-only on purpose: this runs during render, where a removal would be
 * consumed by React's double-invoked/discarded renders (StrictMode) and
 * silently disable the state check. The value is not a secret and is
 * overwritten by the next /connect visit.
 */
export function readConnectCliAuthState(): string | null {
  try {
    return window.sessionStorage.getItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface ConnectCliCallbackResult {
  readonly code: string;
  readonly state: string;
}

export function readConnectCliCallbackResult(
  url: URL = new URL(window.location.href),
): ConnectCliCallbackResult | null {
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!code || !state) {
    return null;
  }
  return { code, state };
}
