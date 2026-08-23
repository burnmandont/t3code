import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";

import * as RelayConfiguration from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointForHostname,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import {
  ManagedEndpointDeprovisioningFailed,
  ManagedEndpointOriginNotAllowed,
  ManagedEndpointProvider,
  type ManagedEndpointProvisioningResult,
  ManagedEndpointProvisioningFailed,
  ManagedEndpointProvisioningNotConfigured,
} from "./ManagedEndpointProviderService.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import * as SovereignConnectorConfiguration from "./SovereignConnectorConfiguration.ts";

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackOrigin(input: {
  readonly localHttpHost: string;
  readonly localHttpPort: number;
}) {
  const hostname = normalizeHostname(input.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(input.localHttpPort) &&
    input.localHttpPort > 0 &&
    input.localHttpPort <= 65_535
  );
}

const requireEndpointSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfiguration["Service"],
  input: { readonly userId: string; readonly environmentId: string },
) {
  const baseDomain = settings.managedEndpointBaseDomain;
  const namespace = settings.managedEndpointNamespace;
  const missingSettings: Array<"managedEndpointBaseDomain" | "managedEndpointNamespace"> = [];
  if (!baseDomain) missingSettings.push("managedEndpointBaseDomain");
  if (!namespace) missingSettings.push("managedEndpointNamespace");
  if (!baseDomain || !namespace) {
    return yield* new ManagedEndpointProvisioningNotConfigured({ ...input, missingSettings });
  }
  return { baseDomain, namespace };
});

const hashConnectorToken = (crypto: Crypto.Crypto, token: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Encoding.encodeHex));

export const make = Effect.gen(function* () {
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const connectorSettings = yield* SovereignConnectorConfiguration.SovereignConnectorConfiguration;
  const crypto = yield* Crypto.Crypto;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const tunnelLimits = yield* ManagedTunnelLimits.ManagedTunnelLimits;

  const prepareDeprovision = Effect.fn("relay.t3_endpoint_provider.prepare_deprovision")(
    function* (input: { readonly userId: string; readonly environmentId: string }) {
      return yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              ...input,
              stage: "load-allocation",
              cause,
            }),
        ),
      );
    },
  );

  return ManagedEndpointProvider.of({
    prepareDeprovision,
    deprovision: Effect.fn("relay.t3_endpoint_provider.deprovision")(function* (input) {
      const allocation =
        input.target === undefined ? yield* prepareDeprovision(input) : input.target;
      if (allocation === null) return;
      const claimedAt = yield* allocations
        .claimDeprovision({
          userId: input.userId,
          environmentId: input.environmentId,
          updatedAt: allocation.updatedAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "claim-deprovision",
                ...(allocation.tunnelId === null ? {} : { tunnelId: allocation.tunnelId }),
                cause,
              }),
          ),
        );
      if (claimedAt === null) return;
      yield* allocations
        .removeClaimed({
          userId: input.userId,
          environmentId: input.environmentId,
          updatedAt: claimedAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "remove-allocation",
                ...(allocation.tunnelId === null ? {} : { tunnelId: allocation.tunnelId }),
                cause,
              }),
          ),
        );
    }),
    release: Effect.fn("relay.t3_endpoint_provider.release")(function* (input) {
      const allocation = yield* prepareDeprovision(input);
      const connectorId = allocation?.tunnelId ?? null;
      if (allocation === null || connectorId === null || allocation.providerKind !== "t3_relay") {
        return true;
      }
      return yield* allocations
        .claimConnectorRevocation({
          userId: input.userId,
          environmentId: input.environmentId,
          connectorId,
          updatedAt: allocation.updatedAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "claim-release",
                tunnelId: connectorId,
                cause,
              }),
          ),
        );
    }),
    provision: Effect.fn("relay.t3_endpoint_provider.provision")(function* (input) {
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          userId: input.userId,
          environmentId: input.environmentId,
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const endpointSettings = yield* requireEndpointSettings(settings, input);
      const digest = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput(
              endpointSettings.namespace,
              input.userId,
              input.environmentId,
            ),
          ),
        )
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "derive-environment-hash",
                cause,
              }),
          ),
        );
      const hostname = managedEndpointHostname(
        endpointSettings.namespace,
        endpointSettings.baseDomain,
        digest,
      );
      const proxyName = managedEndpointTunnelName(endpointSettings.namespace, digest);
      yield* tunnelLimits.ensureCapacity(input).pipe(
        Effect.catchTags({
          ManagedTunnelLimitPersistenceError: (cause) =>
            Effect.fail(
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "check-tunnel-limit",
                hostname,
                tunnelName: proxyName,
                cause,
              }),
            ),
        }),
      );
      const allocation = yield* allocations
        .reserve({
          ...input,
          providerKind: "t3_relay",
          hostname,
          tunnelName: proxyName,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "reserve-allocation",
                hostname,
                tunnelName: proxyName,
                cause,
              }),
          ),
        );
      const randomUuid = crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              ...input,
              stage: "issue-connector-credential",
              hostname: allocation.hostname,
              tunnelName: allocation.tunnelName,
              cause,
            }),
        ),
      );
      const connectorId =
        allocation.providerKind === "t3_relay" && allocation.tunnelId !== null
          ? allocation.tunnelId
          : yield* randomUuid;
      const secret = `${yield* randomUuid}.${yield* randomUuid}`;
      const connectorToken = `${connectorId}.${secret}`;
      const connectorTokenHash = yield* hashConnectorToken(crypto, connectorToken).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointProvisioningFailed({
              ...input,
              stage: "issue-connector-credential",
              hostname: allocation.hostname,
              tunnelName: allocation.tunnelName,
              tunnelId: connectorId,
              cause,
            }),
        ),
      );
      yield* allocations
        .recordConnectorCredential({
          userId: input.userId,
          environmentId: input.environmentId,
          connectorId,
          connectorTokenHash,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointProvisioningFailed({
                ...input,
                stage: "issue-connector-credential",
                hostname: allocation.hostname,
                tunnelName: allocation.tunnelName,
                tunnelId: connectorId,
                cause,
              }),
          ),
        );
      const endpoint = managedEndpointForHostname(allocation.hostname, {
        providerKind: "t3_relay",
        httpScheme: settings.managedEndpointHttpScheme ?? "https",
        ...(settings.managedEndpointHttpPort === undefined
          ? {}
          : { httpPort: settings.managedEndpointHttpPort }),
      });
      return {
        endpoint,
        runtime: {
          providerKind: "t3_relay",
          connectorId,
          connectorToken,
          serverAddr: connectorSettings.serverAddr,
          serverPort: connectorSettings.serverPort,
          proxyName: allocation.tunnelName,
          hostname: allocation.hostname,
          localHttpHost: input.origin.localHttpHost,
          localHttpPort: input.origin.localHttpPort,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
