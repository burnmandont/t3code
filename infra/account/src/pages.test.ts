import { describe, expect, it } from "@effect/vitest";

import { consentPage, signInPage } from "./pages.ts";

describe("sovereign account pages", () => {
  it("offers passkey sign-in and enrollment during the bootstrap phase", () => {
    const html = signInPage("/api/auth", true);

    expect(html).toContain('data-action="passkey-sign-in"');
    expect(html).toContain('data-action="passkey-add"');
    expect(html).toContain('value="cross-platform"');
    expect(html).toContain('data-action="sign-out"');
    expect(html).toContain('data-password-login-enabled="true"');
    expect(html).toContain('<form id="account-form">');
    expect(html).toContain('autocomplete="username webauthn"');
    expect(html).toContain(
      "Password sign-in and account creation are restricted to approved operator networks.",
    );
  });

  it("removes the password form when the passkey-only cutover is enabled", () => {
    const html = signInPage("/account/auth", false);

    expect(html).toContain('data-auth-base-path="/account/auth"');
    expect(html).toContain('data-password-login-enabled="false"');
    expect(html).toContain('<form id="account-form" hidden>');
    expect(html).toContain('data-action="passkey-sign-in"');
  });

  it("keeps OAuth consent on the configured self-hosted auth path", () => {
    expect(consentPage("/account/auth")).toContain('data-auth-base-path="/account/auth"');
  });
});
