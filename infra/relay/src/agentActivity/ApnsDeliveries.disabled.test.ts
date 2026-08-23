import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ApnsDeliveries, layerDisabled } from "./ApnsDeliveries.ts";

describe("ApnsDeliveries.layerDisabled", () => {
  it.effect("keeps target publishing available without claiming a delivery", () =>
    Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries;

      assert.strictEqual(
        yield* deliveries.sendForTarget({
          target: {} as Parameters<typeof deliveries.sendForTarget>[0]["target"],
          aggregate: null,
          nowMs: 0,
        }),
        null,
      );
      assert.strictEqual(
        yield* deliveries.sendPushNotificationForTarget({
          target: {} as Parameters<typeof deliveries.sendPushNotificationForTarget>[0]["target"],
          aggregate: null,
        }),
        null,
      );
    }).pipe(Effect.provide(layerDisabled)),
  );

  it.effect("rejects queue-worker calls explicitly", () =>
    Effect.gen(function* () {
      const deliveries = yield* ApnsDeliveries;
      const exit = yield* Effect.exit(deliveries.processSignedJob({}));

      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(layerDisabled)),
  );
});
