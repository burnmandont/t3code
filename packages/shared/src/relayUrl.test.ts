import { describe, expect, it } from "vite-plus/test";

import { isSecureRelayUrl, normalizeSecureRelayUrl } from "./relayUrl.ts";

describe("normalizeSecureRelayUrl", () => {
  it("normalizes secure relay origins", () => {
    expect(normalizeSecureRelayUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeSecureRelayUrl("https://relay.example.test:8443/")).toBe(
      "https://relay.example.test:8443",
    );
    expect(normalizeSecureRelayUrl("http://127.0.0.1:4100/")).toBe("http://127.0.0.1:4100");
    expect(normalizeSecureRelayUrl("http://localhost:4100/")).toBe("http://localhost:4100");
    expect(normalizeSecureRelayUrl("http://relay.localhost:4100/")).toBe(
      "http://relay.localhost:4100",
    );
    expect(normalizeSecureRelayUrl("http://[::1]:4100/")).toBe("http://[::1]:4100");
  });

  it.each([
    "http://relay.example.test",
    "https://user:password@relay.example.test",
    "https://relay.example.test/path",
    "https://relay.example.test?query=value",
    "https://relay.example.test#fragment",
    "not a url",
  ])("rejects unsafe relay URL %s", (value) => {
    expect(normalizeSecureRelayUrl(value)).toBeNull();
    expect(isSecureRelayUrl(value)).toBe(false);
  });
});
