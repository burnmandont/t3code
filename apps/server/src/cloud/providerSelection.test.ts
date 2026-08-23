import { describe, expect, it } from "vite-plus/test";

import { resolveSovereignProviderSelection } from "./providerSelection.ts";

describe("resolveSovereignProviderSelection", () => {
  it("uses the bundled provider selection when one exists", () => {
    expect(
      resolveSovereignProviderSelection(false, {
        T3CODE_OAUTH_ISSUER: "https://auth.example.test/api/auth",
      }),
    ).toBe(false);
    expect(resolveSovereignProviderSelection(true, {})).toBe(true);
  });

  it("selects sovereign providers from source-development OAuth configuration", () => {
    expect(
      resolveSovereignProviderSelection(undefined, {
        T3CODE_OAUTH_ISSUER: "https://auth.example.test/api/auth",
      }),
    ).toBe(true);
    expect(resolveSovereignProviderSelection(undefined, {})).toBe(false);
  });

  it("selects sovereign providers for a neutral public runtime", () => {
    expect(
      resolveSovereignProviderSelection(undefined, {
        T3CODE_BUILD_NEUTRAL_PUBLIC_RUNTIME: "1",
      }),
    ).toBe(true);
  });
});
