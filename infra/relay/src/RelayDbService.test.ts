import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "./RelayDbService.ts";

describe("RelayDbService", () => {
  it.effect("derives transaction support from the injected database", () => {
    const withTransaction = (() =>
      Effect.die("unused")) as unknown as RelayDb.RelayDb["Service"]["$client"]["withTransaction"];
    const database = {
      $client: { withTransaction },
    } as unknown as RelayDb.RelayDb["Service"];
    const databaseLayer = RelayDb.layerFromDatabase(database);

    return Effect.gen(function* () {
      const transactions = yield* RelayDb.RelayTransactions;
      expect(transactions.withTransaction).toBe(withTransaction);
    }).pipe(Effect.provide(RelayDb.RelayTransactions.layer.pipe(Layer.provide(databaseLayer))));
  });
});
