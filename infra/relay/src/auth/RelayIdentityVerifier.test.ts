import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { vi } from "vite-plus/test";

import * as RelayConfiguration from "../Config.ts";
import * as RelayIdentityVerifier from "./RelayIdentityVerifier.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const layer = RelayIdentityVerifier.layerClerk.pipe(
  Layer.provide(RelayConfiguration.layer(relaySettings)),
);

const resetClerkMocks = Effect.sync(() => {
  vi.mocked(verifyToken).mockReset();
  vi.mocked(createClerkClient).mockReset();
});

describe("RelayIdentityVerifier", () => {
  it.effect("preserves the existing Clerk session JWT path", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: relaySettings.clerkJwtAudience,
      } as never);

      const verifier = yield* RelayIdentityVerifier.RelayIdentityVerifier;
      expect(yield* verifier.verifyClientBearer("session-token")).toEqual({
        userId: "user_session",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith("session-token", {
        secretKey: "clerk-secret-key",
        audience: relaySettings.clerkJwtAudience,
      });
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.ensuring(resetClerkMocks)),
  );

  it.effect("falls back to Clerk OAuth verification for the headless CLI", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: true,
          toAuth: () => ({ userId: "user_oauth" }),
        }),
      } as never);

      const verifier = yield* RelayIdentityVerifier.RelayIdentityVerifier;
      expect(yield* verifier.verifyClientBearer("oauth-token")).toEqual({
        userId: "user_oauth",
        mode: "clerk_oauth_bearer",
      });
      expect(createClerkClient).toHaveBeenCalledWith({
        secretKey: "clerk-secret-key",
        publishableKey: "pk_test_test",
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(resetClerkMocks)),
  );

  it.effect("keeps token exchange on the audience-bound session path", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_exchange",
        aud: relaySettings.clerkJwtAudience,
      } as never);

      const verifier = yield* RelayIdentityVerifier.RelayIdentityVerifier;
      expect(yield* verifier.verifyTokenExchangeSubject("subject-token")).toEqual({
        userId: "user_exchange",
        mode: "clerk_bearer_token_exchange",
      });
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.ensuring(resetClerkMocks)),
  );

  it.effect("does not fall back to an OAuth token for token exchange", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));

      const verifier = yield* RelayIdentityVerifier.RelayIdentityVerifier;
      const error = yield* Effect.flip(verifier.verifyTokenExchangeSubject("oauth-token"));
      expect(error).toBeInstanceOf(RelayIdentityVerifier.RelayIdentityVerificationFailed);
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.ensuring(resetClerkMocks)),
  );
});
