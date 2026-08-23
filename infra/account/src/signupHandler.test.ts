import { describe, expect, it, vi } from "@effect/vitest";

import { withSignupAllowlist } from "./signupHandler.ts";

const signupUrl = "https://auth.example.test/api/auth/sign-up/email";

function signupRequest(email: string) {
  return new Request(signupUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name: "Owner", password: "correct horse battery staple" }),
  });
}

describe("account signup allowlist", () => {
  it("permits an exact case-insensitive allowed email", async () => {
    const auth = vi.fn(async () => Response.json({ user: "owner" }));
    const handler = withSignupAllowlist(auth, "/api/auth", ["Owner@Example.Test"]);
    const response = await handler(signupRequest("owner@example.test"));

    expect(response.status).toBe(200);
    expect(auth).toHaveBeenCalledOnce();
  });

  it("rejects an unlisted email before reaching auth", async () => {
    const auth = vi.fn(async () => Response.json({ user: "attacker" }));
    const handler = withSignupAllowlist(auth, "/api/auth", ["owner@example.test"]);
    const response = await handler(signupRequest("attacker@example.test"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "Account creation is not permitted." });
    expect(auth).not.toHaveBeenCalled();
  });

  it("is closed by default and rejects malformed signup requests before Better Auth", async () => {
    const original = new Response("auth", { status: 422 });
    const auth = vi.fn(async () => original);
    const handler = withSignupAllowlist(auth, "/api/auth", []);

    expect(
      await handler(
        new Request("https://auth.example.test/api/auth/sign-in/email", { method: "POST" }),
      ),
    ).toBe(original);
    const malformed = await handler(
      new Request(signupUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ message: "Invalid account creation request." });
    expect(auth).toHaveBeenCalledOnce();
  });
});
