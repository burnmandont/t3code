import * as Layer from "effect/Layer";

import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as RelayIdentityVerifier from "./auth/RelayIdentityVerifier.ts";
import * as RelayConfiguration from "./Config.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProviderService.ts";
import * as RelayDb from "./RelayDbService.ts";
import * as RelayHttpApp from "./RelayHttpApp.ts";
import * as RelayMaintenance from "./RelayMaintenance.ts";

/**
 * Provider-neutral relay behavior. Deployments supply identity verification,
 * persistence, managed endpoint provisioning, APNs delivery, and configuration
 * around this layer; the API and domain behavior stay identical.
 */
export const make = <ME, MR, AE, AR, IE, IR, PE, PR, CE, CR>(options: {
  readonly managedEndpoint: Layer.Layer<ManagedEndpointProvider.ManagedEndpointProvider, ME, MR>;
  readonly apnsDeliveries: Layer.Layer<ApnsDeliveries.ApnsDeliveries, AE, AR>;
  readonly identity: Layer.Layer<RelayIdentityVerifier.RelayIdentityVerifier, IE, IR>;
  readonly persistence: Layer.Layer<RelayDb.RelayDb | RelayDb.RelayTransactions, PE, PR>;
  readonly configuration: Layer.Layer<RelayConfiguration.RelayConfiguration, CE, CR>;
}) => {
  const domain = Layer.empty.pipe(
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(EnvironmentPublishSignatures.layer),
    Layer.provideMerge(options.managedEndpoint),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(options.apnsDeliveries),
    Layer.provideMerge(AgentActivityRows.layer),
    Layer.provideMerge(Devices.layer),
    Layer.provideMerge(EnvironmentCredentials.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentLinks.layer,
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
      ),
    ),
    Layer.provideMerge(LiveActivities.layer),
    Layer.provideMerge(DeliveryAttempts.layer),
    Layer.provideMerge(Layer.mergeAll(RelayTokens.layer, options.identity)),
    Layer.provideMerge(options.persistence),
    Layer.provideMerge(options.configuration),
    Layer.provideMerge(RelayHttpApp.webcryptoLayer),
  );
  return Layer.merge(domain, RelayMaintenance.layer.pipe(Layer.provide(domain)));
};
