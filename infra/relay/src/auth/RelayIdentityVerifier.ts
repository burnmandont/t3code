import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

export interface RelayIdentity {
  readonly userId: string;
  readonly mode: string;
}

export class RelayIdentityVerificationFailed extends Schema.TaggedErrorClass<RelayIdentityVerificationFailed>()(
  "RelayIdentityVerificationFailed",
  {
    provider: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Relay identity verification failed";
  }
}

export class RelayIdentityVerifier extends Context.Service<
  RelayIdentityVerifier,
  {
    readonly verifyClientBearer: (
      token: string,
    ) => Effect.Effect<RelayIdentity, RelayIdentityVerificationFailed>;
    readonly verifyTokenExchangeSubject: (
      token: string,
    ) => Effect.Effect<RelayIdentity, RelayIdentityVerificationFailed>;
  }
>()("t3code-relay/auth/RelayIdentityVerifier") {}

function hasExpectedAudience(audience: unknown, expectedAudience: string): boolean {
  return typeof audience === "string"
    ? audience === expectedAudience
    : Array.isArray(audience) &&
        audience.some((entry) => typeof entry === "string" && entry === expectedAudience);
}

function verifyClerkSessionBearer(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  return Effect.tryPromise({
    try: () =>
      verifyToken(token, {
        secretKey: Redacted.value(config.clerkSecretKey),
        audience: config.clerkJwtAudience,
      }),
    catch: (cause) => new RelayIdentityVerificationFailed({ provider: "clerk", cause }),
  }).pipe(
    Effect.flatMap((verified) =>
      verified.sub && hasExpectedAudience(verified.aud, config.clerkJwtAudience)
        ? Effect.succeed({
            userId: verified.sub,
            mode: "clerk_session_bearer",
          } satisfies RelayIdentity)
        : Effect.fail(
            new RelayIdentityVerificationFailed({
              provider: "clerk",
              cause: "missing_relay_audience",
            }),
          ),
    ),
    Effect.withSpan("verify_clerk_bearer_token", {
      attributes: { "relay.auth.token_length": token.length },
    }),
  );
}

function verifyClerkOAuthBearer(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const client = createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      });
      const state = await client.authenticateRequest(
        new Request(config.relayIssuer, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { acceptsToken: "oauth_token" },
      );
      const auth = state.toAuth();
      if (!state.isAuthenticated || !auth.userId) {
        throw new Error("Clerk OAuth token is not authenticated.");
      }
      return {
        userId: auth.userId,
        mode: "clerk_oauth_bearer",
      } satisfies RelayIdentity;
    },
    catch: (cause) => new RelayIdentityVerificationFailed({ provider: "clerk", cause }),
  });
}

const makeClerk = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;

  const verifyClientBearer: RelayIdentityVerifier["Service"]["verifyClientBearer"] = Effect.fn(
    "relay.identity.verify_client_bearer",
  )((token) =>
    verifyClerkSessionBearer(config, token).pipe(
      Effect.catch(() => verifyClerkOAuthBearer(config, token)),
    ),
  );

  const verifyTokenExchangeSubject: RelayIdentityVerifier["Service"]["verifyTokenExchangeSubject"] =
    Effect.fn("relay.identity.verify_token_exchange_subject")((token) =>
      verifyClerkSessionBearer(config, token).pipe(
        Effect.map((identity) => ({ ...identity, mode: "clerk_bearer_token_exchange" })),
      ),
    );

  return RelayIdentityVerifier.of({
    verifyClientBearer,
    verifyTokenExchangeSubject,
  });
});

export const layerClerk = Layer.effect(RelayIdentityVerifier, makeClerk);

function safeFailureReason(value: string): string {
  return /^[a-z0-9._-]+$/i.test(value) ? value : "unknown";
}

export function verificationFailureReason(cause: unknown): string {
  if (
    cause instanceof Error &&
    (cause.message.startsWith("Invalid JWT audience claim ") ||
      cause.message.startsWith("Invalid JWT audience claim array "))
  ) {
    return "audience_mismatch";
  }
  if (typeof cause === "object" && cause !== null && "reason" in cause) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return safeFailureReason(reason);
    }
  }
  if (cause instanceof Error && cause.name) {
    return safeFailureReason(cause.name);
  }
  return "unknown";
}
