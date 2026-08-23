import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedErrorClass<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly oauthIssuer: string | null;
  readonly oauthClientId: string | null;
  readonly oauthResource: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export type CloudIdentityConfig =
  | { readonly provider: "clerk"; readonly publishableKey: string }
  | {
      readonly provider: "sovereign";
      readonly issuer: string;
      readonly clientId: string;
      readonly resource: string;
    };

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeOAuthIssuer(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if ((url.protocol !== "https:" && !isLoopbackHttp) || url.search || url.hash) return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    oauthIssuer: trimNonEmpty(import.meta.env.VITE_T3CODE_OAUTH_ISSUER as string | undefined),
    oauthClientId: trimNonEmpty(import.meta.env.VITE_T3CODE_OAUTH_CLIENT_ID as string | undefined),
    oauthResource: trimNonEmpty(import.meta.env.VITE_T3CODE_OAUTH_RESOURCE as string | undefined),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveCloudIdentityConfig(): CloudIdentityConfig | null {
  const config = resolveCloudPublicConfig();
  if (config.oauthIssuer || config.oauthClientId || config.oauthResource) {
    const issuer = normalizeOAuthIssuer(config.oauthIssuer);
    return issuer && config.oauthClientId && config.oauthResource
      ? {
          provider: "sovereign",
          issuer,
          clientId: config.oauthClientId,
          resource: config.oauthResource,
        }
      : null;
  }
  return config.clerkPublishableKey && config.clerkJwtTemplate
    ? { provider: "clerk", publishableKey: config.clerkPublishableKey }
    : null;
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.relayUrl && resolveCloudIdentityConfig());
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
