import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayClient, type RelayClientShape } from "./relayClient.ts";

export type ManagedConnectorProviderKind = Exclude<RelayManagedEndpointProviderKind, "manual">;

export class ManagedConnectorClientNotConfigured extends Data.TaggedError(
  "ManagedConnectorClientNotConfigured",
)<{
  readonly providerKind: ManagedConnectorProviderKind;
}> {}

export class ManagedConnectorClients extends Context.Service<
  ManagedConnectorClients,
  {
    readonly get: (
      providerKind: ManagedConnectorProviderKind,
    ) => Effect.Effect<RelayClientShape, ManagedConnectorClientNotConfigured>;
  }
>()("@t3tools/shared/managedConnectorClients") {}

export function make(
  clients: Partial<Record<ManagedConnectorProviderKind, RelayClientShape>>,
): ManagedConnectorClients["Service"] {
  return ManagedConnectorClients.of({
    get: (providerKind) => {
      const client = clients[providerKind];
      return client
        ? Effect.succeed(client)
        : Effect.fail(new ManagedConnectorClientNotConfigured({ providerKind }));
    },
  });
}

export const layer = (clients: Partial<Record<ManagedConnectorProviderKind, RelayClientShape>>) =>
  Layer.succeed(ManagedConnectorClients, make(clients));

/** Compatibility adapter while the existing CLI still installs cloudflared. */
export const layerCloudflaredFromRelayClient = Layer.effect(
  ManagedConnectorClients,
  RelayClient.pipe(
    Effect.map((client) =>
      make({
        cloudflare_tunnel: client,
      }),
    ),
  ),
);
