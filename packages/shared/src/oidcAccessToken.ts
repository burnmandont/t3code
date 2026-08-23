import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OidcAccessTokenVerificationConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: URL;
}

export interface VerifiedOidcAccessToken {
  readonly subject: string;
  readonly scope: string | ReadonlyArray<string>;
}

export type OidcAccessTokenVerifier = (token: string) => Promise<VerifiedOidcAccessToken>;

export function makeOidcAccessTokenVerifier(
  config: OidcAccessTokenVerificationConfiguration,
  suppliedJwks?: JWTVerifyGetKey,
): OidcAccessTokenVerifier {
  const jwks = suppliedJwks ?? createRemoteJWKSet(config.jwksUrl);
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["EdDSA"],
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ["sub", "iss", "aud", "iat", "exp"],
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("OIDC access token subject is missing.");
    }
    const scope = payload.scope;
    if (
      typeof scope !== "string" &&
      !(Array.isArray(scope) && scope.every((entry) => typeof entry === "string"))
    ) {
      throw new Error("OIDC access token scope is missing.");
    }
    return { subject: payload.sub, scope };
  };
}
