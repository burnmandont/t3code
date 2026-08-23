import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProviderService.ts";
import * as ManagedEndpointProviderT3 from "./ManagedEndpointProviderT3.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import * as SovereignConnectorConfiguration from "./SovereignConnectorConfiguration.ts";

const relaySettings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "http://relay.localhost:4100",
  apns: {
    environment: "sandbox",
    teamId: "unused",
    keyId: "unused",
    privateKey: Redacted.make("unused"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  clerkSecretKey: Redacted.make("unused"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: "connect.localhost",
  managedEndpointNamespace: "dev",
  managedEndpointHttpScheme: "http",
  managedEndpointHttpPort: 8080,
});

function makeAllocationStore() {
  let allocation: ManagedEndpointAllocations.ManagedEndpointAllocation | null = null;
  let generation = 0;
  const nextGeneration = () => `generation-${++generation}`;

  const service = ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    get: () => Effect.sync(() => allocation),
    getByConnectorId: (connectorId) =>
      Effect.sync(() => (allocation?.tunnelId === connectorId ? allocation : null)),
    listOrphaned: () => Effect.succeed([]),
    reserve: (input) =>
      Effect.sync(() => {
        allocation ??= {
          userId: input.userId,
          environmentId: input.environmentId,
          providerKind: input.providerKind ?? "cloudflare_tunnel",
          hostname: input.hostname,
          tunnelId: null,
          tunnelName: input.tunnelName,
          dnsRecordId: null,
          connectorTokenHash: null,
          readyAt: null,
          updatedAt: nextGeneration(),
        };
        return allocation;
      }),
    recordTunnel: () => Effect.die("unused"),
    recordDns: () => Effect.die("unused"),
    recordConnectorCredential: (input) =>
      Effect.sync(() => {
        if (allocation === null) throw new Error("allocation missing");
        allocation = {
          ...allocation,
          providerKind: "t3_relay",
          tunnelId: input.connectorId,
          dnsRecordId: null,
          connectorTokenHash: input.connectorTokenHash,
          readyAt: "2026-08-04T00:00:00.000Z",
          updatedAt: nextGeneration(),
        };
      }),
    markReady: () => Effect.die("unused"),
    claimRelease: () => Effect.die("unused"),
    claimConnectorRevocation: (input) =>
      Effect.sync(() => {
        if (
          allocation === null ||
          allocation.tunnelId !== input.connectorId ||
          allocation.updatedAt !== input.updatedAt
        ) {
          return false;
        }
        allocation = {
          ...allocation,
          connectorTokenHash: null,
          updatedAt: nextGeneration(),
        };
        return true;
      }),
    claimDeprovision: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    removeClaimed: () => Effect.die("unused"),
  });

  return { service, current: () => allocation };
}

function providerLayer(store: ReturnType<typeof makeAllocationStore>) {
  return ManagedEndpointProviderT3.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(relaySettings)),
    Layer.provide(
      SovereignConnectorConfiguration.layer({
        serverAddr: "gateway.example.test",
        serverPort: 7000,
      }),
    ),
    Layer.provide(
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, store.service),
    ),
    Layer.provide(
      Layer.succeed(
        ManagedTunnelLimits.ManagedTunnelLimits,
        ManagedTunnelLimits.ManagedTunnelLimits.of({ ensureCapacity: () => Effect.void }),
      ),
    ),
  );
}

describe("ManagedEndpointProviderT3", () => {
  it.effect("issues a narrow connector runtime and rotates only its secret", () => {
    const store = makeAllocationStore();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const input = {
        userId: "user-1",
        environmentId: "environment-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      } as const;

      const first = yield* provider.provision(input);
      expect(first.endpoint.providerKind).toBe("t3_relay");
      expect(first.endpoint.httpBaseUrl).toMatch(
        /^http:\/\/dev-[a-f0-9]+\.connect\.localhost:8080\/$/u,
      );
      expect(first.runtime.providerKind).toBe("t3_relay");
      if (first.runtime.providerKind !== "t3_relay") return;
      expect(first.runtime).toMatchObject({
        serverAddr: "gateway.example.test",
        serverPort: 7000,
        hostname: new URL(first.endpoint.httpBaseUrl).hostname,
      });
      expect(first.runtime.connectorToken.startsWith(`${first.runtime.connectorId}.`)).toBe(true);
      expect(store.current()?.connectorTokenHash).not.toBe(first.runtime.connectorToken);

      const second = yield* provider.provision(input);
      expect(second.runtime.providerKind).toBe("t3_relay");
      if (second.runtime.providerKind !== "t3_relay") return;
      expect(second.runtime.connectorId).toBe(first.runtime.connectorId);
      expect(second.runtime.connectorToken).not.toBe(first.runtime.connectorToken);
      expect(second.runtime.hostname).toBe(first.runtime.hostname);
    }).pipe(Effect.provide(providerLayer(store)));
  });

  it.effect("revokes readiness while retaining the stable allocation", () => {
    const store = makeAllocationStore();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user-1",
        environmentId: "environment-1",
        origin: { localHttpHost: "localhost", localHttpPort: 3773 },
      });

      expect(yield* provider.release({ userId: "user-1", environmentId: "environment-1" })).toBe(
        true,
      );
      expect(store.current()).toMatchObject({
        providerKind: "t3_relay",
        connectorTokenHash: null,
        readyAt: "2026-08-04T00:00:00.000Z",
      });
      expect(store.current()?.tunnelId).not.toBeNull();
    }).pipe(Effect.provide(providerLayer(store)));
  });

  it.effect("rejects origins outside the local T3 server", () => {
    const store = makeAllocationStore();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user-1",
          environmentId: "environment-1",
          origin: { localHttpHost: "10.0.0.25", localHttpPort: 3773 },
        }),
      );
      expect(error._tag).toBe("ManagedEndpointOriginNotAllowed");
      expect(store.current()).toBeNull();
    }).pipe(Effect.provide(providerLayer(store)));
  });
});
