import { describe, expect, it } from "vite-plus/test";

import { retryDelayMs } from "./SovereignApnsQueue.ts";

describe("sovereign APNs queue", () => {
  it("backs retries off exponentially and caps the delay", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it("does not produce a sub-thirty-second delay for defensive zero input", () => {
    expect(retryDelayMs(0)).toBe(30_000);
  });
});
