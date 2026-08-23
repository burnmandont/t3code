import { describe, expect, it } from "@effect/vitest";

import { loadPublicClientProvisioningConfiguration } from "./clientProvisioning.ts";

describe("public OAuth client provisioning", () => {
  it("normalizes first-party browser, desktop, and mobile redirects", () => {
    expect(
      loadPublicClientProvisioningConfiguration({
        T3_ACCOUNT_CLIENT_ID: " sovereign-t3 ",
        T3_ACCOUNT_CLIENT_REDIRECT_URIS:
          "https://app.example.test/connect/account/callback,t3code://app/connect/account/callback,https://app.example.test/connect/account/callback",
        T3_ACCOUNT_CLIENT_POST_LOGOUT_REDIRECT_URIS: "t3code://signed-out",
      }),
    ).toEqual({
      clientId: "sovereign-t3",
      name: "T3 Code",
      redirectUris: [
        "https://app.example.test/connect/account/callback",
        "t3code://app/connect/account/callback",
      ],
      postLogoutRedirectUris: ["t3code://signed-out"],
      skipConsent: true,
    });
  });

  it("requires redirects and rejects unsafe schemes", () => {
    expect(() => loadPublicClientProvisioningConfiguration({})).toThrow(/REDIRECT_URIS/u);
    expect(() =>
      loadPublicClientProvisioningConfiguration({
        T3_ACCOUNT_CLIENT_REDIRECT_URIS: "javascript:alert(1)",
      }),
    ).toThrow(/unsafe/u);
  });

  it.each([
    "http://app.example.test/callback",
    "ftp://app.example.test/callback",
    "https://user:password@app.example.test/callback",
    "https://app.example.test/callback#fragment",
    "unregistered-app://callback",
  ])("rejects non-HTTPS, credentialed, fragmented, or unknown redirects: %s", (redirectUri) => {
    expect(() =>
      loadPublicClientProvisioningConfiguration({
        T3_ACCOUNT_CLIENT_REDIRECT_URIS: redirectUri,
      }),
    ).toThrow(/unsafe/u);
  });

  it.each([
    "http://localhost:34338/callback",
    "http://127.0.0.1:34338/callback",
    "http://[::1]:34338/callback",
  ])("allows loopback HTTP redirects for native clients: %s", (redirectUri) => {
    expect(
      loadPublicClientProvisioningConfiguration({
        T3_ACCOUNT_CLIENT_REDIRECT_URIS: redirectUri,
      }).redirectUris,
    ).toEqual([redirectUri]);
  });
});
