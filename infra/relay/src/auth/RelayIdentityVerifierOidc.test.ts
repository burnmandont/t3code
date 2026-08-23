import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeWithVerifier } from "./RelayIdentityVerifierOidc.ts";

const config = {
  issuer: "https://account.example.test",
  audience: "https://relay.example.test",
  jwksUrl: new URL("https://account.example.test/jwks"),
  requiredScope: "t3:relay",
} as const;

describe("RelayIdentityVerifierOidc", () => {
  it.effect("accepts only access tokens carrying the relay scope", () =>
    Effect.gen(function* () {
      const verifier = makeWithVerifier(config, async () => ({
        subject: "user-1",
        scope: "openid t3:relay",
      }));
      expect(yield* verifier.verifyClientBearer("signed-token")).toEqual({
        userId: "user-1",
        mode: "oidc_access_token",
      });
      expect(yield* verifier.verifyTokenExchangeSubject("signed-token")).toEqual({
        userId: "user-1",
        mode: "oidc_access_token",
      });

      const wrongScope = makeWithVerifier(config, async () => ({
        subject: "user-1",
        scope: "openid profile",
      }));
      expect((yield* Effect.flip(wrongScope.verifyClientBearer("signed-token"))).provider).toBe(
        "oidc",
      );
    }),
  );
});
