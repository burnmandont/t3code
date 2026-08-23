import { describe, expect, it } from "@effect/vitest";

import { withPublicClientMetadata } from "./oidcHandler.ts";

describe("sovereign OIDC handler", () => {
  it("advertises pre-provisioned public PKCE clients without opening registration", async () => {
    const handler = withPublicClientMetadata(async () =>
      Response.json({
        issuer: "https://auth.example.test/api/auth",
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      }),
    );

    const response = await handler(
      new Request("https://auth.example.test/api/auth/.well-known/openid-configuration"),
    );
    const metadata = (await response.json()) as {
      readonly registration_endpoint?: string;
      readonly token_endpoint_auth_methods_supported: ReadonlyArray<string>;
    };

    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]);
    expect(metadata.registration_endpoint).toBeUndefined();
  });

  it("does not rewrite ordinary account responses", async () => {
    const original = new Response("account", { status: 401 });
    const handler = withPublicClientMetadata(async () => original);

    expect(await handler(new Request("https://auth.example.test/api/auth/get-session"))).toBe(
      original,
    );
  });
});
