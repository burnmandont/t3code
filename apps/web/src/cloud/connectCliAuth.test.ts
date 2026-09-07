import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliOAuthAuthorizeUrl,
  connectCliSignInRedirectUrl,
  hasConnectCliAuthConfig,
  readConnectCliCallbackResult,
} from "./connectCliAuth";

// Any pk_test_* key decodes to <base64 hostname>.clerk.accounts.dev.
const TEST_PUBLISHABLE_KEY = `pk_test_${btoa("witty-mole-42.clerk.accounts.dev$")}`;

describe("connectCliAuth", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_T3CODE_OAUTH_ISSUER", "");
    vi.stubEnv("VITE_T3CODE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("VITE_T3CODE_OAUTH_RESOURCE", "");
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires both the publishable key and the CLI OAuth client id", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.com");
    expect(hasConnectCliAuthConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    expect(hasConnectCliAuthConfig()).toBe(true);
  });

  it("builds the Clerk authorize URL with the configured hosted origin's callback", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://nightly.app.t3.codes");

    const authorizeUrl = buildConnectCliOAuthAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("witty-mole-42.clerk.accounts.dev");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://nightly.app.t3.codes/connect/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("redirects straight to the CLI's loopback listener when the request carries a port", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const authorizeUrl = buildConnectCliOAuthAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
      loopbackPort: 34338,
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("prefers the sovereign issuer and requests relay plus refresh scopes", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_clerk");
    vi.stubEnv("VITE_T3CODE_OAUTH_ISSUER", "https://account.example.test/api/auth/");
    vi.stubEnv("VITE_T3CODE_OAUTH_CLIENT_ID", "t3-code");
    vi.stubEnv("VITE_T3CODE_OAUTH_RESOURCE", "urn:t3:relay");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://code.example.test");

    const authorizeUrl = buildConnectCliOAuthAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.origin).toBe("https://account.example.test");
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("t3-code");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access t3:relay");
    expect(url.searchParams.get("redirect_uri")).toBe("https://code.example.test/connect/callback");
  });

  it("fails closed when sovereign OAuth configuration is incomplete", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_clerk");
    vi.stubEnv("VITE_T3CODE_OAUTH_ISSUER", "https://account.example.test/api/auth");

    expect(hasConnectCliAuthConfig()).toBe(false);
    expect(
      buildConnectCliOAuthAuthorizeUrl({ state: "state-1", challenge: "challenge-1" }),
    ).toBeNull();
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    expect(
      buildConnectCliOAuthAuthorizeUrl({ state: "state-1", challenge: "challenge-1" }),
    ).toBeNull();
  });

  it("sends the sign-in redirect to the authorize endpoint, not back to /connect", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");

    const connectUrl = "https://app.t3.codes/connect#state=state-1&challenge=challenge-1";
    const redirectUrl = connectCliSignInRedirectUrl(
      { state: "state-1", challenge: "challenge-1" },
      connectUrl,
    );

    expect(redirectUrl).not.toBe(connectUrl);
    expect(new URL(redirectUrl).pathname).toBe("/oauth/authorize");
  });

  it("falls back to the current URL when the authorize URL cannot be built", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);

    const connectUrl = "https://app.t3.codes/connect#state=state-1&challenge=challenge-1";
    expect(
      connectCliSignInRedirectUrl({ state: "state-1", challenge: "challenge-1" }, connectUrl),
    ).toBe(connectUrl);
  });

  it("reads the code and state Clerk echoes back to the callback", () => {
    expect(
      readConnectCliCallbackResult(
        new URL("https://app.t3.codes/connect/callback?code=abc&state=state-1"),
      ),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(
      readConnectCliCallbackResult(new URL("https://app.t3.codes/connect/callback?code=abc")),
    ).toBeNull();
    expect(
      readConnectCliCallbackResult(new URL("https://app.t3.codes/connect/callback?state=s")),
    ).toBeNull();
  });
});
