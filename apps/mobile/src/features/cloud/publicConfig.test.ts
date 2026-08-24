import { describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasTracingPublicConfig,
  resolveCloudIdentityConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("reports the missing Clerk JWT template as structured configuration", () => {
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });

  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      oauth: {
        issuer: null,
        clientId: null,
        resource: null,
        redirectScheme: null,
      },
      clerk: {
        publishableKey: null,
        jwtTemplate: null,
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  ", jwtTemplate: "  t3-relay  " },
        relay: { url: " https://relay.example.test/// " },
        observability: {
          tracesUrl: " https://api.axiom.co/v1/traces ",
          tracesDataset: " mobile-traces ",
          tracesToken: " public-ingest-token ",
        },
      }),
    ).toEqual({
      oauth: {
        issuer: null,
        clientId: null,
        resource: null,
        redirectScheme: null,
      },
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: "https://relay.example.test",
      },
      observability: {
        tracesUrl: "https://api.axiom.co/v1/traces",
        tracesDataset: "mobile-traces",
        tracesToken: "public-ingest-token",
      },
    });
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      oauth: {
        issuer: null,
        clientId: null,
        resource: null,
        redirectScheme: null,
      },
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("selects a complete sovereign identity configuration before Clerk", () => {
    const config = resolveCloudPublicConfig({
      oauth: {
        issuer: "https://auth.example.test/api/auth",
        clientId: "t3-code",
        resource: "urn:t3:relay",
        redirectScheme: "sovereign-dev",
      },
      clerk: { publishableKey: "pk_external", jwtTemplate: "external-template" },
      relay: { url: "https://relay.example.test" },
    });

    expect(resolveCloudIdentityConfig(config)).toEqual({
      provider: "sovereign",
      issuer: "https://auth.example.test/api/auth",
      clientId: "t3-code",
      resource: "urn:t3:relay",
      redirectScheme: "sovereign-dev",
    });
  });

  it("fails closed when sovereign identity configuration is partial", () => {
    const config = resolveCloudPublicConfig({
      oauth: {
        issuer: "https://auth.example.test/api/auth",
        clientId: "t3-code",
      },
      clerk: { publishableKey: "pk_external", jwtTemplate: "external-template" },
      relay: { url: "https://relay.example.test" },
    });

    expect(resolveCloudIdentityConfig(config)).toEqual({ provider: "disabled" });
  });

  it("rejects an insecure traces URL", () => {
    expect(
      resolveCloudPublicConfig({
        observability: {
          tracesUrl: "http://api.axiom.co/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      }).observability,
    ).toEqual({
      tracesUrl: null,
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("keeps tracing disabled unless every public tracing value is configured", () => {
    expect(hasTracingPublicConfig(resolveCloudPublicConfig({}))).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
            tracesToken: "public-ingest-token",
          },
        }),
      ),
    ).toBe(true);
  });
});
