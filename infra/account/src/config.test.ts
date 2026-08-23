import { describe, expect, it } from "@effect/vitest";

import { makeAccountOptions, makeOauthProviderOptions, T3_RELAY_SCOPE } from "./auth.ts";
import { loadAccountConfiguration } from "./config.ts";

const validEnvironment = {
  T3_ACCOUNT_BASE_URL: "https://auth.example.test",
  T3_ACCOUNT_DATABASE_URL: "postgresql://account@example.test/account",
  T3_ACCOUNT_SECRET: "a-sovereign-secret-with-at-least-32-characters",
  T3_ACCOUNT_RELAY_AUDIENCE: "https://relay.example.test",
};

describe("account configuration", () => {
  it("loads an explicit sovereign account boundary", () => {
    expect(
      loadAccountConfiguration({
        ...validEnvironment,
        T3_ACCOUNT_HOST: "0.0.0.0",
        T3_ACCOUNT_PORT: "4300",
        T3_ACCOUNT_BASE_PATH: "/account/auth",
        T3_ACCOUNT_TRUSTED_ORIGINS: "https://app.example.test/path, https://mobile.example.test",
        T3_ACCOUNT_ALLOWED_EMAILS: " Owner@Example.Test,second@example.test,owner@example.test ",
      }),
    ).toEqual({
      baseUrl: "https://auth.example.test",
      basePath: "/account/auth",
      databaseUrl: "postgresql://account@example.test/account",
      secret: "a-sovereign-secret-with-at-least-32-characters",
      host: "0.0.0.0",
      port: 4300,
      relayAudience: "https://relay.example.test",
      trustedOrigins: [
        "https://auth.example.test",
        "https://app.example.test",
        "https://mobile.example.test",
      ],
      signupAllowedEmails: ["owner@example.test", "second@example.test"],
      passwordLoginEnabled: true,
    });
  });

  it("rejects weak secrets and invalid ports before starting", () => {
    expect(() =>
      loadAccountConfiguration({ ...validEnvironment, T3_ACCOUNT_SECRET: "too-short" }),
    ).toThrow(/at least 32/u);
    expect(() =>
      loadAccountConfiguration({ ...validEnvironment, T3_ACCOUNT_PORT: "70000" }),
    ).toThrow(/between 1 and 65535/u);
    expect(() =>
      loadAccountConfiguration({ ...validEnvironment, T3_ACCOUNT_BASE_PATH: "relative" }),
    ).toThrow(/absolute URL path/u);
    expect(() =>
      loadAccountConfiguration({
        ...validEnvironment,
        T3_ACCOUNT_PASSWORD_LOGIN_ENABLED: "sometimes",
      }),
    ).toThrow(/must be a boolean/u);
  });

  it("hard-disables telemetry and exposes only the intended relay audience and scope", () => {
    const config = loadAccountConfiguration(validEnvironment);
    const options = makeAccountOptions(config);
    const oauthOptions = makeOauthProviderOptions(config);

    expect(options.telemetry).toEqual({ enabled: false });
    expect(options.basePath).toBe("/api/auth");
    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual(["x-real-ip"]);
    expect(options.rateLimit.customRules["/sign-in/email"]).toEqual({ window: 10, max: 3 });
    expect(options.rateLimit.customRules["/sign-up/email"]).toEqual({ window: 3600, max: 5 });
    expect(options.rateLimit.customRules["/passkey/verify-authentication"]).toEqual({
      window: 10,
      max: 5,
    });
    expect(options.rateLimit.customRules["/passkey/verify-registration"]).toEqual({
      window: 60,
      max: 5,
    });
    expect(options.emailAndPassword.minPasswordLength).toBe(12);
    expect(options.emailAndPassword.maxPasswordLength).toBe(128);
    expect(options.disabledPaths).toEqual(["/token"]);
    expect(config.signupAllowedEmails).toEqual([]);
    expect(options.plugins.map((plugin) => plugin.id)).toEqual([
      "jwt",
      "passkey",
      "oauth-provider",
    ]);
    expect(oauthOptions.validAudiences).toEqual(["https://relay.example.test"]);
    expect(oauthOptions.scopes).toContain(T3_RELAY_SCOPE);
  });

  it("can disable the password bypass after passkey enrollment", () => {
    const config = loadAccountConfiguration({
      ...validEnvironment,
      T3_ACCOUNT_PASSWORD_LOGIN_ENABLED: "false",
    });
    expect(config.passwordLoginEnabled).toBe(false);
    expect(makeAccountOptions(config).emailAndPassword.enabled).toBe(false);
  });
});
