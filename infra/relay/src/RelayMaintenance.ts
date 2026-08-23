import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProviderService.ts";

export const RELAY_MAINTENANCE_INTERVAL = "5 minutes";

export class RelayMaintenance extends Context.Service<
  RelayMaintenance,
  { readonly runOnce: Effect.Effect<void> }
>()("t3code-relay/RelayMaintenance") {}

export const make = Effect.gen(function* () {
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  const activityRows = yield* AgentActivityRows.AgentActivityRows;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;

  const reconcileOrphanedAllocations = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const updatedBefore = DateTime.formatIso(
      DateTime.subtract(now, ManagedEndpointAllocations.ORPHANED_ALLOCATION_GRACE),
    );
    return yield* allocations.listOrphaned({ updatedBefore });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Orphaned managed endpoint discovery failed", {
        errorType: error._tag,
      }).pipe(Effect.as([] as const)),
    ),
    Effect.flatMap((orphaned) =>
      Effect.forEach(
        orphaned,
        (allocation) =>
          managedEndpointProvider
            .deprovision({
              userId: allocation.userId,
              environmentId: allocation.environmentId,
              target: allocation,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Orphaned managed endpoint cleanup failed", {
                  userId: allocation.userId,
                  environmentId: allocation.environmentId,
                  errorType: error._tag,
                }),
              ),
            ),
        { concurrency: 4, discard: true },
      ),
    ),
  );

  const runOnce = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const updatedBefore = DateTime.formatIso(
      DateTime.subtract(now, AgentActivityRows.TERMINAL_AGENT_ACTIVITY_RETENTION),
    );
    yield* Effect.all(
      [
        dpopProofs.pruneExpired.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Scheduled DPoP replay cleanup failed", {
              errorType: error._tag,
              expiresBefore: error.expiresBefore,
            }),
          ),
        ),
        activityRows.pruneTerminal({ updatedBefore }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Scheduled terminal activity cleanup failed", {
              errorType: error._tag,
              updatedBefore: error.updatedBefore,
            }),
          ),
        ),
        reconcileOrphanedAllocations,
      ],
      { concurrency: 3, discard: true },
    );
  }).pipe(Effect.withSpan("relay.maintenance.run_once"));

  return RelayMaintenance.of({ runOnce });
});

export const layer = Layer.effect(RelayMaintenance, make);

/** Runs immediately at process start and then every five minutes. */
export const layerScheduled = Layer.effectDiscard(
  RelayMaintenance.pipe(
    Effect.flatMap((maintenance) => maintenance.runOnce),
    Effect.repeat(Schedule.spaced(RELAY_MAINTENANCE_INTERVAL)),
    Effect.forkScoped,
  ),
);
