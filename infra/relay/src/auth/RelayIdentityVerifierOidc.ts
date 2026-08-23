import {
  makeOidcAccessTokenVerifier,
  type OidcAccessTokenVerifier,
} from "@t3tools/shared/oidcAccessToken";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type RelayIdentity,
  RelayIdentityVerificationFailed,
  RelayIdentityVerifier,
} from "./RelayIdentityVerifier.ts";

export interface OidcIdentityConfiguration {
  readonly issuer: string;
  /** OAuth resource identifier expected in the access-token audience. */
  readonly audience: string;
  readonly jwksUrl: URL;
  readonly requiredScope: string;
}

function hasRequiredScope(scope: string | ReadonlyArray<string>, requiredScope: string): boolean {
  return typeof scope === "string"
    ? scope.split(/\s+/u).includes(requiredScope)
    : scope.includes(requiredScope);
}

export const makeWithVerifier = (
  config: OidcIdentityConfiguration,
  verifyAccessToken: OidcAccessTokenVerifier,
) => {
  const verify = Effect.fn("relay.identity.verify_oidc_access_token")((token: string) =>
    Effect.tryPromise({
      try: () => verifyAccessToken(token),
      catch: (cause) => new RelayIdentityVerificationFailed({ provider: "oidc", cause }),
    }).pipe(
      Effect.flatMap((verified) =>
        hasRequiredScope(verified.scope, config.requiredScope)
          ? Effect.succeed({
              userId: verified.subject,
              mode: "oidc_access_token",
            } satisfies RelayIdentity)
          : Effect.fail(
              new RelayIdentityVerificationFailed({
                provider: "oidc",
                cause: "missing_relay_scope",
              }),
            ),
      ),
      Effect.withSpan("verify_oidc_access_token", {
        attributes: { "relay.auth.token_length": token.length },
      }),
    ),
  );

  return RelayIdentityVerifier.of({
    verifyClientBearer: verify,
    verifyTokenExchangeSubject: verify,
  });
};

export const layerWithVerifier = (
  config: OidcIdentityConfiguration,
  verifyAccessToken: OidcAccessTokenVerifier,
) => Layer.succeed(RelayIdentityVerifier, makeWithVerifier(config, verifyAccessToken));

export const layer = (config: OidcIdentityConfiguration) =>
  layerWithVerifier(config, makeOidcAccessTokenVerifier(config));
