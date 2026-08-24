import { describe, expect, it, vi } from "vite-plus/test";

import {
  makeSovereignMobileAuthClient,
  type SovereignMobileAuthDependencies,
} from "./sovereignMobileAuth";

vi.mock("expo-auth-session", () => ({
  AuthRequest: vi.fn(),
  Prompt: { Login: "login" },
  ResponseType: { Code: "code" },
  exchangeCodeAsync: vi.fn(),
  refreshAsync: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

const config = {
  issuer: "https://auth.example.test/api/auth",
  clientId: "t3-code",
  resource: "https://relay.example.test",
  redirectUri: "sovereign-dev://app/connect/account/callback",
} as const;

function accessToken(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: subject })}.signature`;
}

function tokenResponse(value: {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly issuedAt?: number;
}) {
  return { getRequestConfig: () => value } as never;
}

function makeDependencies(
  input: {
    readonly stored?: string | null;
    readonly nowSeconds?: number;
    readonly promptResult?: unknown;
    readonly exchanged?: ReturnType<typeof tokenResponse>;
    readonly refreshed?: ReturnType<typeof tokenResponse>;
    readonly fetch?: typeof globalThis.fetch;
  } = {},
) {
  let stored = input.stored ?? null;
  const write = vi.fn(async (value: string) => {
    stored = value;
  });
  const remove = vi.fn(async () => {
    stored = null;
  });
  const createRequest = vi.fn(() => ({
    codeVerifier: "pkce-verifier",
    promptAsync: vi.fn(
      async () => input.promptResult ?? { type: "success", params: { code: "authorization-code" } },
    ),
  }));
  const exchangeCode = vi.fn(async () =>
    tokenResponse(
      input.exchanged ?? {
        accessToken: accessToken("account-1"),
        refreshToken: "refresh-1",
        expiresIn: 3_600,
        issuedAt: 1_000,
      },
    ),
  );
  const refresh = vi.fn(async () =>
    tokenResponse(
      input.refreshed ?? {
        accessToken: accessToken("account-1"),
        expiresIn: 3_600,
        issuedAt: 2_000,
      },
    ),
  );
  const fetch =
    input.fetch ??
    (vi.fn(async (request: string | URL | Request) =>
      request.toString().endsWith("/oauth2/userinfo")
        ? Response.json({ sub: "account-1", email: "sam@example.test", name: "Sam" })
        : new Response(null, { status: 200 }),
    ) as typeof globalThis.fetch);
  const dependencies = {
    read: vi.fn(async () => stored),
    write,
    remove,
    createRequest,
    exchangeCode,
    refresh,
    nowSeconds: () => input.nowSeconds ?? 1_000,
    fetch,
  } as unknown as SovereignMobileAuthDependencies;
  return { dependencies, createRequest, exchangeCode, fetch, refresh, remove, write };
}

describe("sovereign mobile OAuth", () => {
  it("restores a fresh encrypted token session", async () => {
    const stored = JSON.stringify({
      accessToken: accessToken("account-1"),
      refreshToken: "refresh-1",
      expiresIn: 3_600,
      issuedAt: 1_000,
    });
    const { dependencies, refresh } = makeDependencies({ stored, nowSeconds: 1_100 });
    const client = makeSovereignMobileAuthClient(config, dependencies);

    await client.initialize();

    expect(client.snapshot()).toEqual({
      isSignedIn: true,
      userId: "account-1",
      email: null,
      name: null,
    });
    expect(await client.getToken()).toBe(accessToken("account-1"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and preserves a rotated-optional refresh token", async () => {
    const stored = JSON.stringify({
      accessToken: accessToken("account-1"),
      refreshToken: "refresh-1",
      expiresIn: 60,
      issuedAt: 1_000,
    });
    const { dependencies, refresh, write } = makeDependencies({ stored, nowSeconds: 2_000 });
    const client = makeSovereignMobileAuthClient(config, dependencies);

    expect(await client.getToken()).toBe(accessToken("account-1"));
    expect(refresh).toHaveBeenCalledWith(
      {
        clientId: "t3-code",
        refreshToken: "refresh-1",
        extraParams: { resource: "https://relay.example.test" },
      },
      {
        authorizationEndpoint: "https://auth.example.test/api/auth/oauth2/authorize",
        tokenEndpoint: "https://auth.example.test/api/auth/oauth2/token",
      },
    );
    expect(JSON.parse(vi.mocked(write).mock.calls[0]![0]).refreshToken).toBe("refresh-1");
  });

  it("uses browser PKCE and persists the sovereign token exchange", async () => {
    const { dependencies, createRequest, exchangeCode, write } = makeDependencies();
    const client = makeSovereignMobileAuthClient(config, dependencies);

    await client.signIn();

    expect(createRequest).toHaveBeenCalledWith({
      clientId: "t3-code",
      redirectUri: "sovereign-dev://app/connect/account/callback",
      responseType: "code",
      prompt: "login",
      scopes: ["openid", "profile", "email", "offline_access", "t3:relay"],
      usePKCE: true,
      extraParams: { resource: "https://relay.example.test" },
    });
    expect(exchangeCode).toHaveBeenCalledWith(
      {
        clientId: "t3-code",
        code: "authorization-code",
        redirectUri: "sovereign-dev://app/connect/account/callback",
        extraParams: {
          code_verifier: "pkce-verifier",
          resource: "https://relay.example.test",
        },
      },
      {
        authorizationEndpoint: "https://auth.example.test/api/auth/oauth2/authorize",
        tokenEndpoint: "https://auth.example.test/api/auth/oauth2/token",
      },
    );
    expect(write).toHaveBeenCalledTimes(2);
    expect(client.snapshot()).toEqual({
      isSignedIn: true,
      userId: "account-1",
      email: "sam@example.test",
      name: "Sam",
    });
  });

  it("clears malformed stored sessions before exposing them", async () => {
    const stored = JSON.stringify({
      accessToken: "not-a-jwt",
      refreshToken: "refresh-1",
      expiresIn: 3_600,
      issuedAt: 1_000,
    });
    const { dependencies, remove } = makeDependencies({ stored });
    const client = makeSovereignMobileAuthClient(config, dependencies);

    await client.initialize();

    expect(remove).toHaveBeenCalledOnce();
    expect(client.snapshot()).toEqual({
      isSignedIn: false,
      userId: null,
      email: null,
      name: null,
    });
  });

  it("revokes the refresh token and clears the secure-store session", async () => {
    const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      expect(request.toString()).toBe("https://auth.example.test/api/auth/oauth2/revoke");
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("client_id")).toBe("t3-code");
      expect(body.get("token")).toBe("refresh-1");
      return new Response(null, { status: 200 });
    });
    const stored = JSON.stringify({
      accessToken: accessToken("account-1"),
      refreshToken: "refresh-1",
      expiresIn: 3_600,
      issuedAt: 1_000,
    });
    const { dependencies, remove } = makeDependencies({
      stored,
      fetch: fetch as typeof globalThis.fetch,
    });
    const client = makeSovereignMobileAuthClient(config, dependencies);

    await expect(client.signOut()).resolves.toEqual({
      isSignedIn: false,
      userId: null,
      email: null,
      name: null,
      revoked: true,
    });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("still clears secure storage when mobile revocation is unavailable", async () => {
    const stored = JSON.stringify({
      accessToken: accessToken("account-1"),
      refreshToken: "refresh-1",
      expiresIn: 3_600,
      issuedAt: 1_000,
    });
    const { dependencies, remove } = makeDependencies({
      stored,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as typeof globalThis.fetch,
    });
    const client = makeSovereignMobileAuthClient(config, dependencies);

    await expect(client.signOut()).resolves.toMatchObject({
      isSignedIn: false,
      revoked: false,
    });
    expect(remove).toHaveBeenCalledOnce();
  });
});
