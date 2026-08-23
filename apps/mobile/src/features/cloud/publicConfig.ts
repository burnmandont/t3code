import Constants from "expo-constants";
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
  readonly oauth: {
    readonly issuer: string | null;
    readonly clientId: string | null;
    readonly resource: string | null;
    readonly redirectScheme: string | null;
  };
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  return {
    oauth: {
      issuer: normalizeSecureUrl(extra?.oauth?.issuer),
      clientId: trimNonEmpty(extra?.oauth?.clientId),
      resource: trimNonEmpty(extra?.oauth?.resource),
      redirectScheme: trimNonEmpty(extra?.oauth?.redirectScheme),
    },
    clerk: {
      publishableKey: trimNonEmpty(extra?.clerk?.publishableKey),
      jwtTemplate: trimNonEmpty(extra?.clerk?.jwtTemplate),
    },
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
    },
    observability: {
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  const hasSovereignIdentity = Boolean(
    config.oauth.issuer &&
    config.oauth.clientId &&
    config.oauth.resource &&
    config.oauth.redirectScheme,
  );
  return Boolean(config.relay.url && hasSovereignIdentity);
}

export type CloudIdentityConfig =
  | {
      readonly provider: "sovereign";
      readonly issuer: string;
      readonly clientId: string;
      readonly resource: string;
      readonly redirectScheme: string;
    }
  | {
      readonly provider: "clerk";
      readonly publishableKey: string;
      readonly jwtTemplate: string;
    }
  | { readonly provider: "disabled" };

export function resolveCloudIdentityConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): CloudIdentityConfig {
  const oauthValues = [
    config.oauth.issuer,
    config.oauth.clientId,
    config.oauth.resource,
    config.oauth.redirectScheme,
  ];
  if (oauthValues.some(Boolean)) {
    return oauthValues.every(Boolean)
      ? {
          provider: "sovereign",
          issuer: config.oauth.issuer!,
          clientId: config.oauth.clientId!,
          resource: config.oauth.resource!,
          redirectScheme: config.oauth.redirectScheme!,
        }
      : { provider: "disabled" };
  }
  if (config.clerk.publishableKey && config.clerk.jwtTemplate) {
    return {
      provider: "clerk",
      publishableKey: config.clerk.publishableKey,
      jwtTemplate: config.clerk.jwtTemplate,
    };
  }
  return { provider: "disabled" };
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}

export function resolveRelayClerkTokenOptions() {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}
