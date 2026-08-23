import type {
  RelayManagedEndpointProviderKind,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type ManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointProviderKind;
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
      readonly proxyName?: string;
      readonly hostname?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "t3_relay";
      readonly pid: number;
      readonly proxyName: string;
      readonly hostname: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointProviderKind;
    };

export class ManagedEndpointRuntime extends Context.Service<
  ManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<ManagedEndpointRuntimeStatus>;
  }
>()("t3/cloud/ManagedEndpointRuntimeService/ManagedEndpointRuntime") {}
