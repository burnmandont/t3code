import { describe, expect, it, vi } from "vite-plus/test";

import { SOVEREIGN_APP_CALLBACK_PATH } from "@t3tools/shared/connectAuth";

import { makeSovereignAuthClient, SovereignAuthError } from "./sovereignAuth";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function accessToken(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
  return `header.${payload}.signature`;
}

const config = {
  appOrigin: "https://code.example.test",
  appProtocol: "https:",
  appHost: "code.example.test",
  authorizationEndpoint: "https://auth.example.test/api/auth/oauth2/authorize",
  tokenEndpoint: "https://auth.example.test/api/auth/oauth2/token",
  clientId: "t3-code",
  redirectUri: `https://code.example.test${SOVEREIGN_APP_CALLBACK_PATH}`,
  resource: "urn:t3:relay",
  scopes: ["openid", "profile", "email", "offline_access", "t3:relay"],
} as const;

describe("sovereign browser OAuth", () => {
  it("uses PKCE and exchanges a matching callback for a durable session", async () => {
    const tokenStorage = memoryStorage();
    const transactionStorage = memoryStorage();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const params = new URLSearchParams(init?.body as string);
      expect(params.get("resource")).toBe("urn:t3:relay");
      expect(params.get("code_verifier")).not.toBeNull();
      return Response.json({
        access_token: accessToken("account-1"),
        refresh_token: "refresh-1",
        expires_in: 900,
      });
    });
    const client = makeSovereignAuthClient(config, {
      tokenStorage,
      transactionStorage,
      fetch: fetch as typeof globalThis.fetch,
      crypto,
      now: () => 1_000,
    });

    const authorizeUrl = new URL(
      await client.beginSignIn("https://code.example.test/settings/connections"),
    );
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("scope")).toContain("t3:relay");
    const state = authorizeUrl.searchParams.get("state");
    const callbackUrl = `https://code.example.test${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1&state=${state}`;
    const [returnUrl, repeatedReturnUrl] = await Promise.all([
      client.completeSignIn(callbackUrl),
      client.completeSignIn(callbackUrl),
    ]);

    expect(returnUrl).toBe("https://code.example.test/settings/connections");
    expect(repeatedReturnUrl).toBe(returnUrl);
    expect(await client.getToken()).toBe(accessToken("account-1"));
    expect(client.snapshot()).toEqual({ isSignedIn: true, userId: "account-1" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects callback state mismatches without contacting the token endpoint", async () => {
    const fetch = vi.fn();
    const client = makeSovereignAuthClient(config, {
      tokenStorage: memoryStorage(),
      transactionStorage: memoryStorage(),
      fetch: fetch as typeof globalThis.fetch,
      crypto,
    });
    await client.beginSignIn("https://code.example.test/");

    await expect(
      client.completeSignIn(
        `https://code.example.test${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1&state=wrong`,
      ),
    ).rejects.toBeInstanceOf(SovereignAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes once for concurrent callers and preserves a rotated refresh token", async () => {
    let now = 1_000;
    const tokenStorage = memoryStorage();
    const transactionStorage = memoryStorage();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const params = new URLSearchParams(init?.body as string);
      const isRefresh = params.get("grant_type") === "refresh_token";
      return Response.json({
        access_token: accessToken(isRefresh ? "account-2" : "account-1"),
        refresh_token: isRefresh ? "refresh-2" : "refresh-1",
        expires_in: isRefresh ? 900 : 1,
      });
    });
    const client = makeSovereignAuthClient(config, {
      tokenStorage,
      transactionStorage,
      fetch: fetch as typeof globalThis.fetch,
      crypto,
      now: () => now,
    });
    const authorizeUrl = new URL(await client.beginSignIn("https://code.example.test/"));
    await client.completeSignIn(
      `https://code.example.test${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1&state=${authorizeUrl.searchParams.get("state")}`,
    );
    now = 60_000;

    const [first, second] = await Promise.all([client.getToken(), client.getToken()]);
    expect(first).toBe(accessToken("account-2"));
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
