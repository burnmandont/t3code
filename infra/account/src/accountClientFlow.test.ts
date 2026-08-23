import { describe, expect, it } from "@effect/vitest";

import {
  oauthContinuationUrl,
  operatorRecoveryMessage,
  passwordSignInErrorMessage,
} from "./accountClientFlow.ts";

describe("sovereign account client flow", () => {
  it("uses the OAuth provider continuation returned after authentication", () => {
    expect(
      oauthContinuationUrl({
        redirect: true,
        url: "t3code://app/connect/account/callback?code=authorization-code",
      }),
    ).toBe("t3code://app/connect/account/callback?code=authorization-code");
  });

  it("does not mistake an ordinary authentication response for an OAuth continuation", () => {
    expect(oauthContinuationUrl({ user: { id: "account-id" } })).toBeNull();
    expect(oauthContinuationUrl({ redirect: false, url: "https://example.test" })).toBeNull();
  });

  it("explains an edge-denied password login", () => {
    expect(passwordSignInErrorMessage(new Error("Forbidden"))).toBe(operatorRecoveryMessage);
    expect(passwordSignInErrorMessage(new Error("Invalid email or password"))).toBe(
      "Invalid email or password",
    );
  });
});
