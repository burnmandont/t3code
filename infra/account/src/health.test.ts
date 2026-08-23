import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeAccountHealthResponse } from "./health.ts";

describe("account health", () => {
  it("reports healthy only after PostgreSQL responds", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [{ ok: 1 }] }));

    const response = await Effect.runPromise(makeAccountHealthResponse({ query }));

    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(response.status).toBe(200);
  });

  it("reports unavailable when PostgreSQL cannot be reached", async () => {
    const query = vi.fn(() => Promise.reject(new Error("database offline")));

    const response = await Effect.runPromise(makeAccountHealthResponse({ query }));

    expect(response.status).toBe(503);
  });
});
