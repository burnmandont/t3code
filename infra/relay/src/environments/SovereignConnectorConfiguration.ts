import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export interface SovereignConnectorSettings {
  /** Publicly reachable frps control address used by frpc. */
  readonly serverAddr: string;
  readonly serverPort: number;
}

export class SovereignConnectorConfiguration extends Context.Service<
  SovereignConnectorConfiguration,
  SovereignConnectorSettings
>()("t3code-relay/environments/SovereignConnectorConfiguration") {}

export const layer = (settings: SovereignConnectorSettings) =>
  Layer.succeed(SovereignConnectorConfiguration, SovereignConnectorConfiguration.of(settings));
