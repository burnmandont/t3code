import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeOidcAccessTokenVerifier } from "./oidcAccessToken.ts";

const issuer = "https://account.example.test";
const audience = "https://relay.example.test";

describe("makeOidcAccessTokenVerifier", () => {
  it.effect("validates the JWT profile and resource audience", () =>
    Effect.gen(function* () {
      const keyPair = yield* Effect.promise(() => generateKeyPair("EdDSA"));
      const publicJwk = yield* Effect.promise(() => exportJWK(keyPair.publicKey));
      const verifier = makeOidcAccessTokenVerifier(
        { issuer, audience, jwksUrl: new URL(`${issuer}/jwks`) },
        createLocalJWKSet({
          keys: [{ ...publicJwk, alg: "EdDSA", kid: "key-1", use: "sig" }],
        }),
      );
      const sign = (tokenAudience: string) =>
        new SignJWT({ scope: "openid t3:relay" })
          .setProtectedHeader({ alg: "EdDSA", kid: "key-1", typ: "at+jwt" })
          .setIssuer(issuer)
          .setAudience(tokenAudience)
          .setSubject("user-1")
          .setIssuedAt()
          .setExpirationTime("5 minutes")
          .sign(keyPair.privateKey);

      const token = yield* Effect.promise(() => sign(audience));
      expect(yield* Effect.promise(() => verifier(token))).toEqual({
        subject: "user-1",
        scope: "openid t3:relay",
      });
      const wrongAudience = yield* Effect.promise(() => sign("https://other.example.test"));
      expect(yield* Effect.exit(Effect.promise(() => verifier(wrongAudience)))).toMatchObject({
        _tag: "Failure",
      });
    }),
  );
});
