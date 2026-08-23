import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class RelayDb extends Context.Service<
  RelayDb,
  PgDrizzle.EffectPgDatabase & {
    readonly $client: PgClient.PgClient;
  }
>()("t3code-relay/RelayDbService/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/RelayDbService/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const layerFromDatabase = (database: RelayDb["Service"]) => Layer.succeed(RelayDb, database);

/**
 * Creates the ordinary PostgreSQL runtime used by non-Worker deployments.
 * Provisioning, migrations, and secret loading remain responsibilities of the
 * process entrypoint; this layer only owns the pooled runtime connection.
 */
export const layerPostgres = (config: PgClient.PgPoolConfig) =>
  Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(Layer.provide(PgClient.layer(config)));
