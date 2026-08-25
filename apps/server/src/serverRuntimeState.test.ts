import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);
const isServerRuntimeStateOwnedError = Schema.is(ServerRuntimeState.ServerRuntimeStateOwnedError);
const encodePersistedServerRuntimeState = Schema.encodeSync(
  Schema.fromJsonString(ServerRuntimeState.PersistedServerRuntimeState),
);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("rejects a second owner while the recorded process is alive", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const owner: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-25T00:00:00.000Z",
      };
      const contender = {
        ...owner,
        pid: process.pid + 1,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-08-25T00:00:01.000Z",
      };

      yield* ServerRuntimeState.claimPersistedServerRuntimeState({ path: statePath, state: owner });
      const error = yield* ServerRuntimeState.claimPersistedServerRuntimeState({
        path: statePath,
        state: contender,
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateOwnedError(error));
      if (isServerRuntimeStateOwnedError(error)) {
        assert.equal(error.ownerPid, process.pid);
        assert.equal(error.contenderPid, process.pid + 1);
      }
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), owner);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes simultaneous ownership claims", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const first: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-25T00:00:00.000Z",
      };
      const second: ServerRuntimeState.PersistedServerRuntimeState = {
        ...first,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-08-25T00:00:01.000Z",
      };

      const outcomes = yield* Effect.all(
        [
          ServerRuntimeState.claimPersistedServerRuntimeState({
            path: statePath,
            state: first,
          }).pipe(Effect.result),
          ServerRuntimeState.claimPersistedServerRuntimeState({
            path: statePath,
            state: second,
          }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      ).pipe(TestClock.withLive);

      assert.equal(outcomes.filter(Result.isSuccess).length, 1);
      assert.equal(outcomes.filter(Result.isFailure).length, 1);
      const rejection = outcomes.find(Result.isFailure);
      assert.isDefined(rejection);
      if (rejection !== undefined && Result.isFailure(rejection)) {
        assert.isTrue(isServerRuntimeStateOwnedError(rejection.failure));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a descriptor owned by a dead process", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const stale: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 2_147_483_647,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-25T00:00:00.000Z",
      };
      const replacement: ServerRuntimeState.PersistedServerRuntimeState = {
        ...stale,
        pid: process.pid,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-08-25T00:00:01.000Z",
      };
      yield* fileSystem.writeFileString(statePath, `${encodePersistedServerRuntimeState(stale)}\n`);

      yield* ServerRuntimeState.claimPersistedServerRuntimeState({
        path: statePath,
        state: replacement,
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), replacement);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not let an old finalizer remove a replacement owner's descriptor", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      const previous: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-25T00:00:00.000Z",
      };
      const replacement: ServerRuntimeState.PersistedServerRuntimeState = {
        ...previous,
        port: 3_774,
        origin: "http://127.0.0.1:3774",
        startedAt: "2026-08-25T00:00:01.000Z",
      };

      yield* ServerRuntimeState.claimPersistedServerRuntimeState({
        path: statePath,
        state: previous,
      });
      yield* ServerRuntimeState.releasePersistedServerRuntimeState({
        path: statePath,
        state: previous,
      });
      yield* ServerRuntimeState.claimPersistedServerRuntimeState({
        path: statePath,
        state: replacement,
      });
      yield* ServerRuntimeState.releasePersistedServerRuntimeState({
        path: statePath,
        state: previous,
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.deepEqual(Option.getOrThrow(restored), replacement);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clears stale descriptors without erasing a live owner", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const livePath = path.join(root, "live.json");
      const stalePath = path.join(root, "stale.json");
      const live: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: process.pid,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-25T00:00:00.000Z",
      };
      const stale: ServerRuntimeState.PersistedServerRuntimeState = {
        ...live,
        pid: 2_147_483_647,
      };
      yield* fileSystem.writeFileString(livePath, `${encodePersistedServerRuntimeState(live)}\n`);
      yield* fileSystem.writeFileString(stalePath, `${encodePersistedServerRuntimeState(stale)}\n`);

      yield* ServerRuntimeState.clearPersistedServerRuntimeState(livePath);
      yield* ServerRuntimeState.clearPersistedServerRuntimeState(stalePath);

      assert.isTrue(yield* fileSystem.exists(livePath));
      assert.isFalse(yield* fileSystem.exists(stalePath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
