import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  resolveCloudIdentityConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

beforeEach(() => {
  vi.stubEnv("VITE_T3CODE_OAUTH_ISSUER", "");
  vi.stubEnv("VITE_T3CODE_OAUTH_CLIENT_ID", "");
  vi.stubEnv("VITE_T3CODE_OAUTH_RESOURCE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("allows an HTTP relay only on a loopback host", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://127.0.0.1:4100");

    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("prefers complete sovereign identity configuration and fails closed when partial", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_T3CODE_OAUTH_ISSUER", "https://auth.example.test/api/auth/");

    expect(resolveCloudIdentityConfig()).toBeNull();
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_OAUTH_CLIENT_ID", "t3-code");
    vi.stubEnv("VITE_T3CODE_OAUTH_RESOURCE", "urn:t3:relay");
    expect(resolveCloudIdentityConfig()).toEqual({
      provider: "sovereign",
      issuer: "https://auth.example.test/api/auth",
      clientId: "t3-code",
      resource: "urn:t3:relay",
    });
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});
