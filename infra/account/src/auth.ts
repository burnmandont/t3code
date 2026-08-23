import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { AccountConfiguration } from "./config.ts";
import * as schema from "./schema.generated.ts";

export const T3_RELAY_SCOPE = "t3:relay";

export function makeOauthProviderOptions(config: AccountConfiguration) {
  return {
    loginPage: "/sign-in",
    consentPage: "/consent",
    scopes: ["openid", "profile", "email", "offline_access", T3_RELAY_SCOPE],
    validAudiences: [config.relayAudience],
    accessTokenExpiresIn: 60 * 60,
    scopeExpirations: { [T3_RELAY_SCOPE]: "15m" },
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    silenceWarnings: {
      oauthAuthServerConfig: true,
      openidConfig: true,
    },
  };
}

export function makeAccountOptions(config: AccountConfiguration) {
  return {
    appName: "T3 Code",
    baseURL: config.baseUrl,
    basePath: config.basePath,
    secret: config.secret,
    telemetry: { enabled: false },
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: {
      enabled: config.passwordLoginEnabled,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
      },
    },
    advanced: {
      useSecureCookies: new URL(config.baseUrl).protocol === "https:",
      // Both trusted proxy layers overwrite X-Real-IP. Reading that single
      // value avoids treating a forwarded chain as client-controlled input.
      ipAddress: {
        ipAddressHeaders: ["x-real-ip"],
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 10, max: 3 },
        "/sign-up/email": { window: 60 * 60, max: 5 },
        "/passkey/generate-authenticate-options": { window: 10, max: 5 },
        "/passkey/verify-authentication": { window: 10, max: 5 },
        "/passkey/generate-register-options": { window: 60, max: 5 },
        "/passkey/verify-registration": { window: 60, max: 5 },
        "/.well-known/openid-configuration": false as const,
        "/.well-known/oauth-authorization-server": false as const,
        "/jwks": false as const,
      },
    },
    disabledPaths: ["/token"],
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwks: {
          keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
          rotationInterval: 30 * 24 * 60 * 60,
          gracePeriod: 30 * 24 * 60 * 60,
        },
      }),
      passkey({
        rpID: new URL(config.baseUrl).hostname,
        rpName: "T3 Code Sovereign",
        origin: new URL(config.baseUrl).origin,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      }),
      oauthProvider(makeOauthProviderOptions(config)),
    ],
  };
}

export function makeAccountAuth(
  config: AccountConfiguration,
  database: Pool = new Pool({ connectionString: config.databaseUrl }),
) {
  return betterAuth({
    ...makeAccountOptions(config),
    database: drizzleAdapter(drizzle(database, { schema }), {
      provider: "pg",
      schema,
    }),
  });
}
