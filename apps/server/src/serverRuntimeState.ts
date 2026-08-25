import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedErrorClass<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "claim", "read", "decode", "release", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

export class ServerRuntimeStateOwnedError extends Schema.TaggedErrorClass<ServerRuntimeStateOwnedError>()(
  "ServerRuntimeStateOwnedError",
  {
    statePath: Schema.String,
    ownerPid: Schema.Int,
    contenderPid: Schema.Int,
  },
) {
  override get message(): string {
    return `Server runtime state at ${this.statePath} is already owned by live process ${this.ownerPid}.`;
  }
}

const STATE_LOCK_RETRY_COUNT = 400;
const STATE_LOCK_RETRY_DELAY = "25 millis";
const STATE_LOCK_STALE_MS = 1_000;
let stateLockSequence = 0;

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const encodePersistedServerRuntimeState = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
  }));

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const sameRuntimeOwner = (
  left: PersistedServerRuntimeState,
  right: PersistedServerRuntimeState,
): boolean => left.pid === right.pid && left.startedAt === right.startedAt;

const withServerRuntimeStateLock = Effect.fn("serverRuntimeState.withLock")(function* <A, E, R>(
  statePath: string,
  operation: ServerRuntimeStateError["operation"],
  effect: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = `${statePath}.lock`;
  const lockOwner = `${process.pid}:${yield* Clock.currentTimeNanos}:${stateLockSequence++}`;
  yield* fs.makeDirectory(path.dirname(statePath), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation,
          statePath,
          cause,
        }),
    ),
  );

  let acquired = false;
  for (let attempt = 0; attempt < STATE_LOCK_RETRY_COUNT; attempt += 1) {
    acquired = yield* fs.writeFileString(lockPath, lockOwner, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        cause.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(cause),
      ),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation,
            statePath,
            cause,
          }),
      ),
    );
    if (acquired) break;

    const now = yield* Clock.currentTimeMillis;
    const lockInfo = yield* fs.stat(lockPath).pipe(Effect.option);
    const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
    if (Option.isSome(mtime) && now - mtime.value.getTime() > STATE_LOCK_STALE_MS) {
      const observedOwner = yield* fs.readFileString(lockPath).pipe(Effect.option);
      const ownerPid = Option.flatMap(observedOwner, (value) => {
        const parsed = Number.parseInt(value.split(":", 1)[0] ?? "", 10);
        return Number.isInteger(parsed) && parsed > 0 ? Option.some(parsed) : Option.none<number>();
      });
      if (Option.isNone(ownerPid) || !isProcessAlive(ownerPid.value)) {
        yield* fs.remove(lockPath, { force: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ServerRuntimeStateError({
                operation,
                statePath,
                cause,
              }),
          ),
        );
        continue;
      }
    }
    yield* Effect.sleep(STATE_LOCK_RETRY_DELAY);
  }

  if (!acquired) {
    return yield* new ServerRuntimeStateError({
      operation,
      statePath,
      cause: new Error("Timed out waiting for the server runtime state lock."),
    });
  }

  const releaseLock = fs.readFileString(lockPath).pipe(
    Effect.flatMap((observedOwner) =>
      observedOwner === lockOwner ? fs.remove(lockPath, { force: true }) : Effect.void,
    ),
    Effect.ignore,
  );
  return yield* effect.pipe(Effect.ensuring(releaseLock));
});

const writeOwnedServerRuntimeState = Effect.fn("serverRuntimeState.writeOwned")(function* (
  input: {
    readonly path: string;
    readonly state: PersistedServerRuntimeState;
  },
  operation: "persist" | "claim",
) {
  const existing = yield* readPersistedServerRuntimeState(input.path);
  if (
    Option.isSome(existing) &&
    !sameRuntimeOwner(existing.value, input.state) &&
    isProcessAlive(existing.value.pid)
  ) {
    return yield* new ServerRuntimeStateOwnedError({
      statePath: input.path,
      ownerPid: existing.value.pid,
      contenderPid: input.state.pid,
    });
  }

  const encoded = yield* encodePersistedServerRuntimeState(input.state).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation,
          statePath: input.path,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({
    filePath: input.path,
    contents: `${encoded}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation,
          statePath: input.path,
          cause,
        }),
    ),
  );
});

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  withServerRuntimeStateLock(input.path, "persist", writeOwnedServerRuntimeState(input, "persist"));

export const claimPersistedServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) => withServerRuntimeStateLock(input.path, "claim", writeOwnedServerRuntimeState(input, "claim"));

export const releasePersistedServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  withServerRuntimeStateLock(
    input.path,
    "release",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const existing = yield* readPersistedServerRuntimeState(input.path);
      if (Option.isNone(existing) || !sameRuntimeOwner(existing.value, input.state)) return;
      yield* fs.remove(input.path, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerRuntimeStateError({
              operation: "release",
              statePath: input.path,
              cause,
            }),
        ),
      );
    }),
  );

export const clearPersistedServerRuntimeState = (path: string) =>
  withServerRuntimeStateLock(
    path,
    "clear",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const existing = yield* readPersistedServerRuntimeState(path);
      if (Option.isSome(existing) && isProcessAlive(existing.value.pid)) return;
      yield* fs.remove(path, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerRuntimeStateError({
              operation: "clear",
              statePath: path,
              cause,
            }),
        ),
      );
    }),
  ).pipe(
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
        ),
    }),
  );

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
          Effect.as(Option.none<PersistedServerRuntimeState>()),
        ),
    }),
  );
