import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ManagedConnectorClients from "./managedConnectorClients.ts";
import type { RelayClientShape } from "./relayClient.ts";

const cloudflared = {
  resolve: Effect.die("unused"),
  install: Effect.die("unused"),
  installWithProgress: () => Effect.die("unused"),
} satisfies RelayClientShape;

describe("ManagedConnectorClients", () => {
  it.effect("selects clients by managed endpoint provider", () =>
    Effect.gen(function* () {
      const clients = ManagedConnectorClients.make({ cloudflare_tunnel: cloudflared });

      expect(yield* clients.get("cloudflare_tunnel")).toBe(cloudflared);
      const error = yield* Effect.flip(clients.get("t3_relay"));
      expect(error).toEqual(
        new ManagedConnectorClients.ManagedConnectorClientNotConfigured({
          providerKind: "t3_relay",
        }),
      );
    }),
  );
});
