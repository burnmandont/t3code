import { describe, expect, it } from "vite-plus/test";

import { parseRelayAllowedOrigins } from "./sovereign.ts";

describe("sovereign relay allowed origins", () => {
  it("preserves exact host-based desktop origins", () => {
    expect(
      parseRelayAllowedOrigins("https://code.moondiner.com,t3code://app,t3code-dev://app"),
    ).toEqual(["https://code.moondiner.com", "t3code://app", "t3code-dev://app"]);
  });

  it("normalizes web origins and removes duplicates", () => {
    expect(
      parseRelayAllowedOrigins("https://code.moondiner.com/path, https://code.moondiner.com"),
    ).toEqual(["https://code.moondiner.com"]);
  });

  it.each(["t3code-dev://app/path", "t3code-dev://app?query=value", "t3code-dev://user@app"])(
    "rejects a custom scheme that is not an origin: %s",
    (origin) => {
      expect(() => parseRelayAllowedOrigins(origin)).toThrow("Invalid host-based custom origin");
    },
  );
});
