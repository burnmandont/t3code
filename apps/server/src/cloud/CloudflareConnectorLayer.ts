import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ConnectorClient from "@t3tools/shared/connectorClient";
import * as FrpcClient from "@t3tools/shared/frpcClient";
import * as ManagedConnectorClients from "@t3tools/shared/managedConnectorClients";
import * as RelayClient from "@t3tools/shared/relayClient";

/**
 * Compatibility provider for upstream Cloudflare builds. Keeping this module
 * behind a build-time dynamic boundary prevents cloudflared download and
 * execution code from entering Sovereign runtimes.
 */
export const relayClientLayer = (baseDir: string) => RelayClient.layerCloudflared({ baseDir });

export const layer = Layer.effect(
  ManagedConnectorClients.ManagedConnectorClients,
  Effect.all({
    cloudflared: ConnectorClient.RelayClient,
    frpc: FrpcClient.FrpcClient,
  }).pipe(
    Effect.map(({ cloudflared, frpc }) =>
      ManagedConnectorClients.make({
        cloudflare_tunnel: cloudflared,
        t3_relay: frpc,
      }),
    ),
  ),
);
