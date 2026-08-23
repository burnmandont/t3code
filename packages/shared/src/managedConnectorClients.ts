import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { RelayClientShape } from "./connectorClient.ts";
import { FrpcClient } from "./frpcClient.ts";

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

export const layerFromFrpcClient = Layer.effect(
  ManagedConnectorClients,
  FrpcClient.pipe(Effect.map((frpc) => make({ t3_relay: frpc }))),
);
