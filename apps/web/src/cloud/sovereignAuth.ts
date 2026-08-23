import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TOKEN_STORAGE_KEY = "t3code:sovereign-oauth-token:v1";
const TRANSACTION_STORAGE_KEY = "t3code:sovereign-oauth-transaction:v1";
const TOKEN_EXPIRY_SKEW_MS = 30_000;

const StoredToken = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
);
type StoredToken = typeof StoredToken.Type;

const OAuthTransaction = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    verifier: Schema.String,
    returnUrl: Schema.String,
  }),
);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
});

const decodeStoredToken = Schema.decodeUnknownOption(StoredToken);
const decodeTransaction = Schema.decodeUnknownOption(OAuthTransaction);
const decodeTokenResponse = Schema.decodeUnknownOption(OAuthTokenResponse);
const encodeStoredToken = Schema.encodeSync(StoredToken);
const encodeTransaction = Schema.encodeSync(OAuthTransaction);

export interface SovereignAuthConfiguration {
  readonly appOrigin: string;
  readonly appProtocol: string;
  readonly appHost: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scopes: ReadonlyArray<string>;
}

export interface SovereignAuthDependencies {
  readonly tokenStorage: Storage;
  readonly transactionStorage: Storage;
  readonly fetch: typeof globalThis.fetch;
  readonly crypto: Crypto;
  readonly now?: () => number;
}

export class SovereignAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SovereignAuthError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function randomValue(crypto: Crypto, size: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

function readToken(storage: Storage): StoredToken | null {
  const encoded = storage.getItem(TOKEN_STORAGE_KEY);
  if (!encoded) return null;
  const decoded = decodeStoredToken(encoded);
  return Option.isSome(decoded) ? decoded.value : null;
}

function tokenSubject(token: string): string | null {
  try {
    const subject = decodeRelayJwt(token).sub;
    return typeof subject === "string" && subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

export function makeSovereignAuthClient(
  config: SovereignAuthConfiguration,
  dependencies: SovereignAuthDependencies,
) {
  const now = dependencies.now ?? Date.now;
  let refreshInFlight: Promise<StoredToken | null> | null = null;
  let completionInFlight: Promise<string> | null = null;

  const saveToken = (token: StoredToken) => {
    dependencies.tokenStorage.setItem(TOKEN_STORAGE_KEY, encodeStoredToken(token));
    return token;
  };

  const clear = () => {
    dependencies.tokenStorage.removeItem(TOKEN_STORAGE_KEY);
    dependencies.transactionStorage.removeItem(TRANSACTION_STORAGE_KEY);
  };

  const exchange = async (params: Record<string, string>): Promise<StoredToken> => {
    const response = await dependencies.fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: config.resource }),
    });
    if (!response.ok)
      throw new SovereignAuthError("The account service rejected the OAuth token request.");
    const decoded = decodeTokenResponse(await response.json());
    if (Option.isNone(decoded))
      throw new SovereignAuthError("The account service returned an invalid OAuth token response.");
    const refreshToken = decoded.value.refresh_token ?? params.refresh_token;
    if (!refreshToken)
      throw new SovereignAuthError("The account service did not return a refresh token.");
    return saveToken({
      accessToken: decoded.value.access_token,
      refreshToken,
      expiresAt: now() + decoded.value.expires_in * 1_000,
    });
  };

  const refresh = async (token: StoredToken): Promise<StoredToken | null> => {
    try {
      return await exchange({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: config.clientId,
      });
    } catch {
      clear();
      return null;
    }
  };

  const getToken = async (): Promise<string | null> => {
    const token = readToken(dependencies.tokenStorage);
    if (!token) return null;
    if (token.expiresAt > now() + TOKEN_EXPIRY_SKEW_MS) return token.accessToken;
    refreshInFlight ??= refresh(token).finally(() => {
      refreshInFlight = null;
    });
    return (await refreshInFlight)?.accessToken ?? null;
  };

  const beginSignIn = async (returnUrl: string): Promise<string> => {
    const parsedReturnUrl = new URL(returnUrl, config.appOrigin);
    if (
      parsedReturnUrl.origin !== config.appOrigin ||
      parsedReturnUrl.protocol !== config.appProtocol ||
      parsedReturnUrl.host !== config.appHost
    ) {
      throw new SovereignAuthError("OAuth return URL must use the T3 app origin.");
    }
    const verifier = randomValue(dependencies.crypto, 32);
    const challenge = base64Url(
      new Uint8Array(
        await dependencies.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      ),
    );
    const state = randomValue(dependencies.crypto, 16);
    dependencies.transactionStorage.setItem(
      TRANSACTION_STORAGE_KEY,
      encodeTransaction({ state, verifier, returnUrl: parsedReturnUrl.toString() }),
    );
    const url = new URL(config.authorizationEndpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  };

  const completeSignInOnce = async (callbackUrl: string): Promise<string> => {
    const transactionEncoded = dependencies.transactionStorage.getItem(TRANSACTION_STORAGE_KEY);
    const transaction = transactionEncoded ? decodeTransaction(transactionEncoded) : Option.none();
    const callback = new URL(callbackUrl);
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");
    if (Option.isNone(transaction) || !code || state !== transaction.value.state) {
      throw new SovereignAuthError("OAuth callback does not match the sign-in request.");
    }
    await exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: transaction.value.verifier,
    });
    dependencies.transactionStorage.removeItem(TRANSACTION_STORAGE_KEY);
    return transaction.value.returnUrl;
  };

  const completeSignIn = (callbackUrl: string): Promise<string> => {
    completionInFlight ??= completeSignInOnce(callbackUrl).finally(() => {
      completionInFlight = null;
    });
    return completionInFlight;
  };

  const snapshot = () => {
    const token = readToken(dependencies.tokenStorage);
    const userId = token ? tokenSubject(token.accessToken) : null;
    return { isSignedIn: userId !== null, userId };
  };

  return { beginSignIn, completeSignIn, getToken, snapshot, clear };
}
