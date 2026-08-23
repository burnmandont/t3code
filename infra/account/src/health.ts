import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

interface AccountHealthDatabase {
  readonly query: (sql: string) => Promise<unknown>;
}

export const makeAccountHealthResponse = (database: AccountHealthDatabase) =>
  Effect.tryPromise(() => database.query("SELECT 1")).pipe(
    Effect.as(HttpServerResponse.jsonUnsafe({ ok: true, service: "account" })),
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { ok: false, service: "account", reason: "database_unavailable" },
          { status: 503 },
        ),
      ),
    ),
  );
