import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProviderService.ts";
import * as RelayMaintenance from "./RelayMaintenance.ts";

const now = DateTime.makeUnsafe("2026-08-08T16:00:00.000Z");

function dependencies(input?: {
  readonly pruneDpop?: DpopProofs.DpopProofReplay["Service"]["pruneExpired"];
  readonly pruneTerminal?: AgentActivityRows.AgentActivityRows["Service"]["pruneTerminal"];
  readonly pruneDeliveryAttempts?: DeliveryAttempts.DeliveryAttempts["Service"]["pruneBefore"];
  readonly listOrphaned?: ManagedEndpointAllocations.ManagedEndpointAllocations["Service"]["listOrphaned"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
}) {
  const pruneDpop = vi.fn(() => input?.pruneDpop ?? Effect.void);
  const pruneTerminal = vi.fn((request: { readonly updatedBefore: string }) =>
    (input?.pruneTerminal ?? (() => Effect.void))(request),
  );
  const pruneDeliveryAttempts = vi.fn((request: { readonly createdBefore: string }) =>
    (input?.pruneDeliveryAttempts ?? (() => Effect.void))(request),
  );
  const listOrphaned = vi.fn(input?.listOrphaned ?? (() => Effect.succeed([])));
  const deprovision = vi.fn(input?.deprovision ?? (() => Effect.void));
  return {
    pruneDpop,
    pruneTerminal,
    pruneDeliveryAttempts,
    listOrphaned,
    deprovision,
    layer: Layer.mergeAll(
      Layer.succeed(DpopProofs.DpopProofReplay, {
        verifyAndConsume: () => Effect.die("not used"),
        consume: () => Effect.die("not used"),
        pruneExpired: Effect.suspend(pruneDpop),
      }),
      Layer.succeed(AgentActivityRows.AgentActivityRows, {
        upsert: () => Effect.die("not used"),
        remove: () => Effect.die("not used"),
        listForUser: () => Effect.die("not used"),
        getForUserThread: () => Effect.die("not used"),
        pruneTerminal,
      }),
      Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
        record: () => Effect.die("not used"),
        claimSourceJob: () => Effect.die("not used"),
        completeSourceJob: () => Effect.die("not used"),
        pruneBefore: pruneDeliveryAttempts,
      }),
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, {
        get: () => Effect.die("not used"),
        getByConnectorId: () => Effect.die("not used"),
        listOrphaned,
        reserve: () => Effect.die("not used"),
        recordTunnel: () => Effect.die("not used"),
        recordDns: () => Effect.die("not used"),
        recordConnectorCredential: () => Effect.die("not used"),
        markReady: () => Effect.die("not used"),
        claimRelease: () => Effect.die("not used"),
        claimConnectorRevocation: () => Effect.die("not used"),
        claimDeprovision: () => Effect.die("not used"),
        remove: () => Effect.die("not used"),
        removeClaimed: () => Effect.die("not used"),
      }),
      Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
        provision: () => Effect.die("not used"),
        prepareDeprovision: () => Effect.die("not used"),
        deprovision,
        release: () => Effect.die("not used"),
      }),
    ),
  };
}

describe("RelayMaintenance", () => {
  it.effect("prunes both expiring relay stores with the upstream retention window", () => {
    const deps = dependencies();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const maintenance = yield* RelayMaintenance.RelayMaintenance;
      yield* maintenance.runOnce;

      expect(deps.pruneDpop).toHaveBeenCalledOnce();
      expect(deps.pruneTerminal).toHaveBeenCalledWith({
        updatedBefore: "2026-08-08T15:30:00.000Z",
      });
      expect(deps.pruneDeliveryAttempts).toHaveBeenCalledWith({
        createdBefore: "2026-07-09T16:00:00.000Z",
      });
      expect(deps.deprovision).not.toHaveBeenCalled();
      expect(deps.listOrphaned).toHaveBeenCalledWith({
        updatedBefore: "2026-08-08T15:45:00.000Z",
      });
    }).pipe(
      Effect.provide(
        RelayMaintenance.layer.pipe(Layer.provideMerge(Layer.merge(deps.layer, TestClock.layer()))),
      ),
    );
  });

  it.effect("reconciles allocations that no longer have an active managed link", () => {
    const orphaned: ManagedEndpointAllocations.ManagedEndpointAllocation = {
      userId: "previous-owner",
      environmentId: "environment-1",
      providerKind: "t3_relay",
      hostname: "environment.connect.example.test",
      tunnelId: "connector-1",
      tunnelName: "environment-proxy",
      dnsRecordId: null,
      connectorTokenHash: "hash",
      readyAt: "2026-08-08T15:00:00.000Z",
      updatedAt: "2026-08-08T15:30:00.000Z",
    };
    const deps = dependencies({ listOrphaned: () => Effect.succeed([orphaned]) });
    return Effect.gen(function* () {
      const maintenance = yield* RelayMaintenance.RelayMaintenance;
      yield* maintenance.runOnce;

      expect(deps.deprovision).toHaveBeenCalledWith({
        userId: orphaned.userId,
        environmentId: orphaned.environmentId,
        target: orphaned,
      });
    }).pipe(Effect.provide(RelayMaintenance.layer.pipe(Layer.provideMerge(deps.layer))));
  });

  it.effect("isolates cleanup failures so the next maintenance cycle can retry", () => {
    const deps = dependencies({
      pruneDpop: Effect.fail(
        new DpopProofs.DpopProofReplayPersistenceError({
          operation: "prune-expired",
          cause: "database unavailable",
        }),
      ),
      pruneTerminal: () =>
        Effect.fail(
          new AgentActivityRows.AgentActivityRowPruneTerminalPersistenceError({
            updatedBefore: "2026-08-08T15:30:00.000Z",
            cause: "database unavailable",
          }),
        ),
      pruneDeliveryAttempts: () =>
        Effect.fail(
          new DeliveryAttempts.DeliveryAttemptRecordPersistenceError({
            operation: "prune-before",
            sourceJobId: null,
            userId: null,
            environmentId: null,
            threadId: null,
            deviceId: null,
            kind: null,
            cause: "database unavailable",
          }),
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const maintenance = yield* RelayMaintenance.RelayMaintenance;
      yield* maintenance.runOnce;

      expect(deps.pruneDpop).toHaveBeenCalledOnce();
      expect(deps.pruneTerminal).toHaveBeenCalledOnce();
      expect(deps.pruneDeliveryAttempts).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provide(
        RelayMaintenance.layer.pipe(Layer.provideMerge(Layer.merge(deps.layer, TestClock.layer()))),
      ),
    );
  });

  it.effect("retries an orphan after its first deprovision attempt fails", () => {
    const orphaned: ManagedEndpointAllocations.ManagedEndpointAllocation = {
      userId: "previous-owner",
      environmentId: "environment-retry",
      providerKind: "t3_relay",
      hostname: "retry.connect.example.test",
      tunnelId: "connector-retry",
      tunnelName: "environment-proxy",
      dnsRecordId: null,
      connectorTokenHash: "hash",
      readyAt: "2026-08-08T15:00:00.000Z",
      updatedAt: "2026-08-08T15:30:00.000Z",
    };
    let attempt = 0;
    const deps = dependencies({
      listOrphaned: () => Effect.succeed([orphaned]),
      deprovision: () => {
        attempt += 1;
        return attempt === 1
          ? Effect.fail(
              new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                stage: "delete-tunnel",
                userId: orphaned.userId,
                environmentId: orphaned.environmentId,
                cause: "frps unavailable",
              }),
            )
          : Effect.void;
      },
    });
    return Effect.gen(function* () {
      const maintenance = yield* RelayMaintenance.RelayMaintenance;
      yield* maintenance.runOnce;
      yield* maintenance.runOnce;

      expect(deps.deprovision).toHaveBeenCalledTimes(2);
      expect(attempt).toBe(2);
    }).pipe(Effect.provide(RelayMaintenance.layer.pipe(Layer.provideMerge(deps.layer))));
  });
});
