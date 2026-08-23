// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface T3CodePublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly oauthIssuer: string | undefined;
  readonly oauthClientId: string | undefined;
  readonly oauthResource: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

const PUBLIC_CONFIG_ENV_NAMES = [
  "T3CODE_HOSTED_APP_URL",
  "VITE_HOSTED_APP_URL",
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "VITE_CLERK_JWT_TEMPLATE",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_OAUTH_ISSUER",
  "VITE_T3CODE_OAUTH_ISSUER",
  "EXPO_PUBLIC_T3CODE_OAUTH_ISSUER",
  "T3CODE_OAUTH_CLIENT_ID",
  "VITE_T3CODE_OAUTH_CLIENT_ID",
  "EXPO_PUBLIC_T3CODE_OAUTH_CLIENT_ID",
  "T3CODE_OAUTH_RESOURCE",
  "VITE_T3CODE_OAUTH_RESOURCE",
  "EXPO_PUBLIC_T3CODE_OAUTH_RESOURCE",
  "T3CODE_RELAY_URL",
  "VITE_T3CODE_RELAY_URL",
  "T3CODE_MOBILE_OTLP_TRACES_URL",
  "EXPO_PUBLIC_OTLP_TRACES_URL",
  "T3CODE_MOBILE_OTLP_TRACES_DATASET",
  "EXPO_PUBLIC_OTLP_TRACES_DATASET",
  "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
  "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "VITE_RELAY_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "VITE_RELAY_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
  "VITE_RELAY_OTLP_TRACES_TOKEN",
] as const;

function neutralPublicBuildEnvironment(baseEnv: Environment): Record<string, string | undefined> {
  const neutral = { ...baseEnv };
  for (const name of PUBLIC_CONFIG_ENV_NAMES) neutral[name] = undefined;
  return neutral;
}

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const neutralPublicRuntime = baseEnv.T3CODE_BUILD_NEUTRAL_PUBLIC_RUNTIME?.trim() === "1";
  const effectiveBaseEnv = neutralPublicRuntime ? neutralPublicBuildEnvironment(baseEnv) : baseEnv;
  const rootEnv = neutralPublicRuntime ? {} : readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = neutralPublicRuntime ? {} : readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(effectiveBaseEnv, localEnv, rootEnv);

  return {
    ...rootEnv,
    ...localEnv,
    ...effectiveBaseEnv,
    ...(config.clerkPublishableKey
      ? {
          T3CODE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          T3CODE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.oauthIssuer
      ? {
          T3CODE_OAUTH_ISSUER: config.oauthIssuer,
          VITE_T3CODE_OAUTH_ISSUER: config.oauthIssuer,
          EXPO_PUBLIC_T3CODE_OAUTH_ISSUER: config.oauthIssuer,
        }
      : {}),
    ...(config.oauthClientId
      ? {
          T3CODE_OAUTH_CLIENT_ID: config.oauthClientId,
          VITE_T3CODE_OAUTH_CLIENT_ID: config.oauthClientId,
          EXPO_PUBLIC_T3CODE_OAUTH_CLIENT_ID: config.oauthClientId,
        }
      : {}),
    ...(config.oauthResource
      ? {
          T3CODE_OAUTH_RESOURCE: config.oauthResource,
          VITE_T3CODE_OAUTH_RESOURCE: config.oauthResource,
          EXPO_PUBLIC_T3CODE_OAUTH_RESOURCE: config.oauthResource,
        }
      : {}),
    ...(config.relayUrl
      ? {
          T3CODE_RELAY_URL: config.relayUrl,
          VITE_T3CODE_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          T3CODE_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "T3CODE_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    oauthIssuer: firstNonEmpty(
      sources,
      "T3CODE_OAUTH_ISSUER",
      "VITE_T3CODE_OAUTH_ISSUER",
      "EXPO_PUBLIC_T3CODE_OAUTH_ISSUER",
    ),
    oauthClientId: firstNonEmpty(
      sources,
      "T3CODE_OAUTH_CLIENT_ID",
      "VITE_T3CODE_OAUTH_CLIENT_ID",
      "EXPO_PUBLIC_T3CODE_OAUTH_CLIENT_ID",
    ),
    oauthResource: firstNonEmpty(
      sources,
      "T3CODE_OAUTH_RESOURCE",
      "VITE_T3CODE_OAUTH_RESOURCE",
      "EXPO_PUBLIC_T3CODE_OAUTH_RESOURCE",
    ),
    relayUrl: firstNonEmpty(sources, "T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
