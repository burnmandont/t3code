import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";

import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedErrorClass<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(
      Schema.Literals(["managedEndpointBaseDomain", "managedEndpointNamespace"]),
    ),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning is not configured for user '${this.userId}', environment '${this.environmentId}': missing ${this.missingSettings.join(", ")}`;
  }
}

const ManagedEndpointProvisioningStage = Schema.Literals([
  "derive-environment-hash",
  "check-tunnel-limit",
  "reserve-allocation",
  "ensure-tunnel",
  "validate-tunnel-response",
  "record-tunnel",
  "configure-tunnel",
  "ensure-dns-record",
  "record-dns",
  "get-tunnel-token",
  "issue-connector-credential",
  "mark-allocation-ready",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    returnedTunnelName: Schema.optionalKey(Schema.String),
    returnedTunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "claim-release",
  "claim-deprovision",
  "delete-dns-record",
  "delete-tunnel",
  "remove-allocation",
]);

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedErrorClass<ManagedEndpointDeprovisioningFailed>()(
  "ManagedEndpointDeprovisioningFailed",
  {
    stage: ManagedEndpointDeprovisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedErrorClass<ManagedEndpointOriginNotAllowed>()(
  "ManagedEndpointOriginNotAllowed",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed endpoint origin '${this.host}:${this.port}' is not allowed for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export type ManagedEndpointDeprovisionTarget = ManagedEndpointAllocations.ManagedEndpointAllocation;

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    /**
     * Captures the allocation generation owned by an unlink before its link
     * revocation commits. Passing this target to `deprovision` prevents a
     * concurrent relink from having its newer allocation torn down.
     */
    readonly prepareDeprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<
      ManagedEndpointDeprovisionTarget | null,
      ManagedEndpointDeprovisioningFailed
    >;
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly target?: ManagedEndpointDeprovisionTarget | null;
    }) => Effect.Effect<void, ManagedEndpointDeprovisioningFailed>;
    /**
     * Stops the active connector credential while retaining the stable endpoint
     * allocation for a later provision. Resolves to false when a concurrent
     * provision won the lifecycle race and its newer connector remains live.
     */
    readonly release: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
  }
>()("t3code-relay/environments/ManagedEndpointProviderService/ManagedEndpointProvider") {}
