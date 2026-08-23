const OIDC_METADATA_PATHS = new Set([
  "/api/auth/.well-known/openid-configuration",
  "/api/auth/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
]);

/**
 * Better Auth 1.6 only advertises the public-client auth method when anonymous
 * dynamic registration is enabled. Pre-provisioned public PKCE clients work
 * without open registration, so keep registration closed and correct the
 * discovery document at our adapter boundary.
 */
export function withPublicClientMetadata(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handler(request);
    if (!OIDC_METADATA_PATHS.has(new URL(request.url).pathname) || !response.ok) {
      return response;
    }

    const metadata = (await response.json()) as {
      readonly token_endpoint_auth_methods_supported?: ReadonlyArray<string>;
      readonly [key: string]: unknown;
    };
    const methods = metadata.token_endpoint_auth_methods_supported ?? [];
    if (methods.includes("none")) return Response.json(metadata, response);

    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return Response.json(
      {
        ...metadata,
        token_endpoint_auth_methods_supported: ["none", ...methods],
      },
      { status: response.status, statusText: response.statusText, headers },
    );
  };
}
