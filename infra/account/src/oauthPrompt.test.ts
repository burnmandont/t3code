import { describe, expect, it } from "vite-plus/test";

import { hasOauthPrompt } from "./oauthPrompt.ts";

describe("sovereign OAuth prompt handling", () => {
  it("recognizes an exact prompt in a space-separated signed query", () => {
    expect(hasOauthPrompt("prompt=login", "login")).toBe(true);
    expect(hasOauthPrompt("prompt=consent+login", "login")).toBe(true);
  });

  it("does not match absent prompts or prompt substrings", () => {
    expect(hasOauthPrompt(undefined, "login")).toBe(false);
    expect(hasOauthPrompt("prompt=select_account", "login")).toBe(false);
    expect(hasOauthPrompt("prompt=login_hint", "login")).toBe(false);
  });
});
