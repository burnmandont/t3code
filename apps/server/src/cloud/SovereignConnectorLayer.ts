import * as Layer from "effect/Layer";

import * as ConnectorClient from "@t3tools/shared/connectorClient";
import * as FrpcClient from "@t3tools/shared/frpcClient";
import * as ManagedConnectorClients from "@t3tools/shared/managedConnectorClients";

/** Sovereign build replacement for the upstream Cloudflare compatibility module. */
export const relayClientLayer = (_baseDir: string) =>
  Layer.effect(ConnectorClient.RelayClient, FrpcClient.FrpcClient);

export const layer = ManagedConnectorClients.layerFromFrpcClient;
