import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { SOVEREIGN_CONNECT_OAUTH_SCOPES } from "@t3tools/shared/connectAuth";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const SOVEREIGN_MOBILE_TOKEN_KEY = "t3code.sovereign.oauth-token.v1";
const TOKEN_EXPIRY_SKEW_SECONDS = 30;

interface StoredMobileToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly issuedAt: number;
  readonly userInfo?: SovereignMobileUserInfo;
}

const OAuthUserInfoResponse = Schema.Struct({
  sub: Schema.String,
  email: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeUserInfoResponse = Schema.decodeUnknownOption(OAuthUserInfoResponse);

export interface SovereignMobileUserInfo {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
}

export interface SovereignMobileAuthConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly resource: string;
  readonly redirectUri: string;
}

export interface SovereignMobileAuthDependencies {
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly createRequest: (
    config: AuthSession.AuthRequestConfig,
  ) => Pick<AuthSession.AuthRequest, "codeVerifier" | "promptAsync">;
  readonly exchangeCode: typeof AuthSession.exchangeCodeAsync;
  readonly refresh: typeof AuthSession.refreshAsync;
  readonly nowSeconds: () => number;
  readonly fetch: typeof globalThis.fetch;
}

export interface SovereignMobileAuthSnapshot {
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
}

function decodeStoredToken(value: string | null): StoredMobileToken | null {
  if (!value) return null;
  try {
    const token = JSON.parse(value) as Partial<StoredMobileToken>;
    return typeof token.accessToken === "string" &&
      typeof token.refreshToken === "string" &&
      typeof token.expiresIn === "number" &&
      typeof token.issuedAt === "number"
      ? {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresIn: token.expiresIn,
          issuedAt: token.issuedAt,
          ...(isMobileUserInfo(token.userInfo) ? { userInfo: token.userInfo } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function isMobileUserInfo(value: unknown): value is SovereignMobileUserInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SovereignMobileUserInfo>;
  return (
    typeof candidate.userId === "string" &&
    (typeof candidate.email === "string" || candidate.email === null) &&
    (typeof candidate.name === "string" || candidate.name === null)
  );
}

function userIdFromAccessToken(accessToken: string): string | null {
  try {
    const subject = decodeRelayJwt(accessToken).sub;
    return typeof subject === "string" && subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

function tokenIsFresh(token: StoredMobileToken, nowSeconds: number): boolean {
  return nowSeconds + TOKEN_EXPIRY_SKEW_SECONDS < token.issuedAt + token.expiresIn;
}

function defaultDependencies(): SovereignMobileAuthDependencies {
  return {
    read: () => SecureStore.getItemAsync(SOVEREIGN_MOBILE_TOKEN_KEY),
    write: (value) => SecureStore.setItemAsync(SOVEREIGN_MOBILE_TOKEN_KEY, value),
    remove: () => SecureStore.deleteItemAsync(SOVEREIGN_MOBILE_TOKEN_KEY),
    createRequest: (config) => new AuthSession.AuthRequest(config),
    exchangeCode: AuthSession.exchangeCodeAsync,
    refresh: AuthSession.refreshAsync,
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    fetch: globalThis.fetch.bind(globalThis),
  };
}

export function makeSovereignMobileAuthClient(
  config: SovereignMobileAuthConfiguration,
  dependencies: SovereignMobileAuthDependencies = defaultDependencies(),
) {
  const discovery = {
    authorizationEndpoint: `${config.issuer.replace(/\/+$/gu, "")}/oauth2/authorize`,
    tokenEndpoint: `${config.issuer.replace(/\/+$/gu, "")}/oauth2/token`,
  };
  const normalizedIssuer = config.issuer.replace(/\/+$/gu, "");
  let token: StoredMobileToken | null = null;
  let initialized = false;
  let initializeInFlight: Promise<void> | null = null;
  let refreshInFlight: Promise<StoredMobileToken | null> | null = null;

  const saveToken = async (nextToken: StoredMobileToken) => {
    token = nextToken;
    await dependencies.write(JSON.stringify(nextToken));
    return nextToken;
  };

  const clear = async () => {
    token = null;
    initialized = true;
    await dependencies.remove();
  };

  const initialize = async () => {
    if (initialized) return;
    initializeInFlight ??= (async () => {
      token = decodeStoredToken(await dependencies.read());
      if (token && !userIdFromAccessToken(token.accessToken)) {
        token = null;
        await dependencies.remove();
      }
      initialized = true;
    })().finally(() => {
      initializeInFlight = null;
    });
    await initializeInFlight;
  };

  const refresh = async (current: StoredMobileToken): Promise<StoredMobileToken | null> => {
    try {
      const response = await dependencies.refresh(
        {
          clientId: config.clientId,
          refreshToken: current.refreshToken,
          extraParams: { resource: config.resource },
        },
        discovery,
      );
      const nextToken = response.getRequestConfig();
      if (!nextToken.accessToken) return null;
      return await saveToken({
        accessToken: nextToken.accessToken,
        refreshToken: nextToken.refreshToken ?? current.refreshToken,
        expiresIn: nextToken.expiresIn ?? current.expiresIn,
        issuedAt: nextToken.issuedAt ?? dependencies.nowSeconds(),
        ...(current.userInfo === undefined ? {} : { userInfo: current.userInfo }),
      });
    } catch {
      await clear();
      return null;
    }
  };

  const getToken = async (): Promise<string | null> => {
    await initialize();
    if (!token) return null;
    if (tokenIsFresh(token, dependencies.nowSeconds())) return token.accessToken;
    refreshInFlight ??= refresh(token).finally(() => {
      refreshInFlight = null;
    });
    return (await refreshInFlight)?.accessToken ?? null;
  };

  const getUserInfo = async (): Promise<SovereignMobileUserInfo | null> => {
    const accessToken = await getToken();
    if (!accessToken || !token) return null;
    const response = await dependencies.fetch(`${normalizedIssuer}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error("The sovereign account service rejected user information.");
    const decoded = decodeUserInfoResponse(await response.json());
    if (Option.isNone(decoded)) {
      throw new Error("The sovereign account service returned invalid user information.");
    }
    const userInfo: SovereignMobileUserInfo = {
      userId: decoded.value.sub,
      email: decoded.value.email ?? null,
      name: decoded.value.name ?? null,
    };
    await saveToken({ ...token, userInfo });
    return userInfo;
  };

  const signIn = async (): Promise<SovereignMobileAuthSnapshot> => {
    const request = dependencies.createRequest({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      responseType: AuthSession.ResponseType.Code,
      // A native sign-in is always an explicit account-selection action. The
      // browser session can outlive the app token on iOS, so require a fresh
      // authentication instead of silently reusing the previous account.
      prompt: AuthSession.Prompt.Login,
      scopes: [...SOVEREIGN_CONNECT_OAUTH_SCOPES],
      usePKCE: true,
      extraParams: { resource: config.resource },
    });
    const result = await request.promptAsync(discovery);
    if (result.type !== "success") return snapshot();
    const code = result.params.code;
    const verifier = request.codeVerifier;
    if (!code || !verifier) throw new Error("The sovereign OAuth response was incomplete.");

    const response = await dependencies.exchangeCode(
      {
        clientId: config.clientId,
        code,
        redirectUri: config.redirectUri,
        extraParams: { code_verifier: verifier, resource: config.resource },
      },
      discovery,
    );
    const exchanged = response.getRequestConfig();
    if (!exchanged.refreshToken) {
      throw new Error("The sovereign account service did not return a refresh token.");
    }
    if (!userIdFromAccessToken(exchanged.accessToken)) {
      throw new Error("The sovereign account service returned an invalid access token.");
    }
    await saveToken({
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      expiresIn: exchanged.expiresIn ?? 0,
      issuedAt: exchanged.issuedAt ?? dependencies.nowSeconds(),
    });
    try {
      await getUserInfo();
    } catch {
      // Identity display is non-critical; the signed access token still
      // establishes the account and can be refreshed on the next launch.
    }
    return snapshot();
  };

  const signOut = async () => {
    await initialize();
    const current = token;
    let revoked = current === null;
    try {
      if (current) {
        const response = await dependencies.fetch(`${normalizedIssuer}/oauth2/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            token: current.refreshToken,
            token_type_hint: "refresh_token",
          }).toString(),
        });
        revoked = response.ok;
      }
    } catch {
      revoked = false;
    } finally {
      await clear();
    }
    return { ...snapshot(), revoked };
  };

  const snapshot = (): SovereignMobileAuthSnapshot => {
    const userId = token ? userIdFromAccessToken(token.accessToken) : null;
    return {
      isSignedIn: userId !== null,
      userId,
      email: token?.userInfo?.email ?? null,
      name: token?.userInfo?.name ?? null,
    };
  };

  return { clear, getToken, getUserInfo, initialize, signIn, signOut, snapshot };
}
