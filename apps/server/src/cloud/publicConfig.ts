import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
  SOVEREIGN_CONNECT_OAUTH_SCOPES,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { isLoopbackHttpHostname, normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_HOSTED_APP_URL__: string | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_OAUTH_ISSUER__: string | undefined;
declare const __T3CODE_BUILD_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_OAUTH_RESOURCE__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
export const buildTimeHostedAppUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_HOSTED_APP_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_HOSTED_APP_URL__,
);
export const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
export const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
export const buildTimeOAuthIssuer = readBuildTimeValue(
  typeof __T3CODE_BUILD_OAUTH_ISSUER__ === "undefined" ? undefined : __T3CODE_BUILD_OAUTH_ISSUER__,
);
export const buildTimeOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OAUTH_CLIENT_ID__,
);
export const buildTimeOAuthResource = readBuildTimeValue(
  typeof __T3CODE_BUILD_OAUTH_RESOURCE__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OAUTH_RESOURCE__,
);
export const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.nonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapOrFail(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

/**
 * Hosted app origin used for out-of-band OAuth on headless
 * machines. Overridable so staging/nightly builds can point their CLIs at a
 * matching hosted deployment.
 */
export function makeHostedAppUrlConfig(fallback = buildTimeHostedAppUrl || DEFAULT_HOSTED_APP_URL) {
  return makePublicValueConfig("T3CODE_HOSTED_APP_URL", fallback).pipe(
    Config.mapOrFail(validateHostedAppUrl),
  );
}

export const hostedAppUrlConfig = makeHostedAppUrlConfig();

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp = url.protocol === "http:" && isLoopbackHttpHostname(url.hostname);
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.nonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

function makeOptionalPublicValueConfig(name: string, fallback: string) {
  return Config.string(name).pipe(
    Config.withDefault(fallback),
    Config.map((value) => value.trim()),
  );
}

function normalizeOAuthIssuer(value: string): string {
  const url = new URL(value);
  const isLoopbackHttp = url.protocol === "http:" && isLoopbackHttpHostname(url.hostname);
  if ((url.protocol !== "https:" && !isLoopbackHttp) || url.search !== "" || url.hash !== "") {
    throw new Error("OAuth issuer must be HTTPS (or HTTP loopback) without query or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

export interface CloudCliOAuthConfig {
  readonly provider: "clerk" | "sovereign";
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly resource?: string;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
  oauthIssuerFallback = buildTimeOAuthIssuer,
  oauthClientIdFallback = buildTimeOAuthClientId,
  oauthResourceFallback = buildTimeOAuthResource,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
  readonly oauthIssuerFallback?: string;
  readonly oauthClientIdFallback?: string;
  readonly oauthResourceFallback?: string;
} = {}) {
  return Config.all({
    clerkPublishableKey: makeOptionalPublicValueConfig(
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKeyFallback,
    ),
    clerkClientId: makeOptionalPublicValueConfig(
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      clerkCliOAuthClientIdFallback,
    ),
    oauthIssuer: makeOptionalPublicValueConfig("T3CODE_OAUTH_ISSUER", oauthIssuerFallback),
    oauthClientId: makeOptionalPublicValueConfig("T3CODE_OAUTH_CLIENT_ID", oauthClientIdFallback),
    oauthResource: makeOptionalPublicValueConfig("T3CODE_OAUTH_RESOURCE", oauthResourceFallback),
  }).pipe(
    Config.mapOrFail(
      ({ clerkPublishableKey, clerkClientId, oauthIssuer, oauthClientId, oauthResource }) => {
        if (oauthIssuer || oauthClientId || oauthResource) {
          if (!oauthIssuer || !oauthClientId || !oauthResource) {
            return Effect.fail(
              new Config.ConfigError(
                new ConfigProvider.SourceError({
                  message:
                    "T3CODE_OAUTH_ISSUER, T3CODE_OAUTH_CLIENT_ID, and T3CODE_OAUTH_RESOURCE must be configured together.",
                  cause: new Error("Incomplete sovereign OAuth configuration."),
                }),
              ),
            );
          }
          return Effect.try({
            try: (): CloudCliOAuthConfig => {
              const issuer = normalizeOAuthIssuer(oauthIssuer);
              return {
                provider: "sovereign",
                authorizationEndpoint: `${issuer}/oauth2/authorize`,
                tokenEndpoint: `${issuer}/oauth2/token`,
                clientId: oauthClientId,
                loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
                redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
                scopes: SOVEREIGN_CONNECT_OAUTH_SCOPES,
                resource: oauthResource,
              } satisfies CloudCliOAuthConfig;
            },
            catch: (cause) =>
              new Config.ConfigError(
                new ConfigProvider.SourceError({
                  message: "T3CODE_OAUTH_ISSUER is not a valid OAuth issuer URL.",
                  cause,
                }),
              ),
          });
        }
        if (!clerkPublishableKey || !clerkClientId) {
          return Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: "Sovereign OAuth or Clerk OAuth public configuration is required.",
                cause: new Error("No complete OAuth provider configuration was found."),
              }),
            ),
          );
        }
        return Effect.try({
          try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
          catch: (cause) =>
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: "Failed to derive Clerk Frontend API URL from the publishable key.",
                cause,
              }),
            ),
        }).pipe(
          Effect.map(
            (clerkFrontendApiUrl): CloudCliOAuthConfig => ({
              provider: "clerk",
              authorizationEndpoint: `${clerkFrontendApiUrl}/oauth/authorize`,
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              clientId: clerkClientId,
              loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
              redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
              scopes: CONNECT_OAUTH_SCOPES,
            }),
          ),
        );
      },
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (normalizeSecureRelayUrl(process.env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
  (((process.env.T3CODE_OAUTH_ISSUER?.trim() || buildTimeOAuthIssuer) &&
    (process.env.T3CODE_OAUTH_CLIENT_ID?.trim() || buildTimeOAuthClientId) &&
    (process.env.T3CODE_OAUTH_RESOURCE?.trim() || buildTimeOAuthResource)) ||
    ((process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
      (process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId))),
);
