import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionProjectNotes", (it) => {
  it.effect("adds non-null project notes with an empty default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_projects)`;
      const notes = columns.find((column) => column.name === "notes");

      assert.equal(notes?.name, "notes");
      assert.equal(notes?.notnull, 1);
      assert.equal(notes?.dflt_value, "''");
    }),
  );
});
