import { describe, expect, it } from "vite-plus/test";

import { validateSovereignDesktopEnvironment } from "./sovereign-desktop.ts";

const validEnvironment = {
  T3CODE_OAUTH_ISSUER: "https://auth.example.test/api/auth",
  T3CODE_OAUTH_CLIENT_ID: "t3-code",
  T3CODE_OAUTH_RESOURCE: "https://relay.example.test",
  T3CODE_RELAY_URL: "https://relay.example.test",
  VITE_HOSTED_APP_URL: "https://code.example.test",
  VITE_REMOTE_FAVICONS: "0",
} as const;

describe("sovereign desktop launcher", () => {
  it("accepts a complete first-party configuration", () => {
    expect(validateSovereignDesktopEnvironment(validEnvironment)).toEqual([]);
  });

  it("reports every missing required value", () => {
    expect(validateSovereignDesktopEnvironment({ VITE_REMOTE_FAVICONS: "0" })).toEqual([
      "Missing required public configuration: T3CODE_OAUTH_ISSUER, T3CODE_OAUTH_CLIENT_ID, T3CODE_OAUTH_RESOURCE, T3CODE_RELAY_URL, VITE_HOSTED_APP_URL.",
    ]);
  });

  it("rejects insecure and credential-bearing endpoints", () => {
    expect(
      validateSovereignDesktopEnvironment({
        ...validEnvironment,
        T3CODE_RELAY_URL: "http://relay.example.test",
        VITE_HOSTED_APP_URL: "https://user:password@code.example.test",
      }),
    ).toEqual([
      "T3CODE_RELAY_URL must use HTTPS; received http://relay.example.test.",
      "VITE_HOSTED_APP_URL must not contain credentials.",
    ]);
  });

  it("rejects external identity, telemetry, and favicon services", () => {
    expect(
      validateSovereignDesktopEnvironment({
        ...validEnvironment,
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_external",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "external-token",
        VITE_REMOTE_FAVICONS: "1",
      }),
    ).toEqual([
      "External identity and telemetry configuration must remain unset: T3CODE_CLERK_PUBLISHABLE_KEY, T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN.",
      "VITE_REMOTE_FAVICONS must be 0 so clients do not request third-party favicons.",
    ]);
  });
});
