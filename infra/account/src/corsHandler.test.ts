import { describe, expect, it, vi } from "@effect/vitest";

import { withTrustedOriginCors } from "./corsHandler.ts";

const accountUrl = "https://auth.example.test/api/auth/oauth2/token";
const appOrigin = "https://code.example.test";

describe("account trusted-origin CORS", () => {
  it("exposes auth responses only to an exact trusted origin", async () => {
    const handler = withTrustedOriginCors(
      async () => Response.json({ access_token: "token" }),
      [appOrigin],
    );
    const response = await handler(
      new Request(accountUrl, { method: "POST", headers: { origin: appOrigin } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("rejects an untrusted browser origin before reaching auth", async () => {
    const auth = vi.fn(async () => new Response("auth"));
    const handler = withTrustedOriginCors(auth, [appOrigin]);
    const response = await handler(
      new Request(accountUrl, {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(auth).not.toHaveBeenCalled();
  });

  it("answers trusted preflight without invoking auth", async () => {
    const auth = vi.fn(async () => new Response("auth"));
    const handler = withTrustedOriginCors(auth, [appOrigin]);
    const response = await handler(
      new Request(accountUrl, { method: "OPTIONS", headers: { origin: appOrigin } }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(auth).not.toHaveBeenCalled();
  });

  it("leaves non-browser and non-auth requests unchanged", async () => {
    const original = new Response("account", { status: 401 });
    const auth = vi.fn(async () => original);
    const handler = withTrustedOriginCors(auth, [appOrigin]);

    expect(await handler(new Request(accountUrl, { method: "POST" }))).toBe(original);
    expect(
      await handler(
        new Request("https://auth.example.test/health", {
          headers: { origin: appOrigin },
        }),
      ),
    ).toBe(original);
  });
});
