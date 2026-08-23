import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as FrpcClient from "@t3tools/shared/frpcClient";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as ManagedConnectorClients from "@t3tools/shared/managedConnectorClients";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const relayClientAvailableLayer = Layer.succeed(
  RelayClient.RelayClient,
  RelayClient.RelayClient.of({
    resolve: Effect.succeed({
      status: "available",
      executablePath: "cloudflared",
      source: "path",
      version: RelayClient.CLOUDFLARED_VERSION,
    }),
    install: Effect.die("unused"),
    installWithProgress: () => Effect.die("unused"),
  }),
);

const frpcClientAvailableLayer = Layer.succeed(
  FrpcClient.FrpcClient,
  FrpcClient.FrpcClient.of({
    resolve: Effect.succeed({
      status: "available",
      executablePath: "frpc",
      source: "path",
      version: FrpcClient.FRPC_VERSION,
    }),
    install: Effect.die("unused"),
    installWithProgress: () => Effect.die("unused"),
  }),
);

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = relayClientAvailableLayer,
  frpcLayer = frpcClientAvailableLayer,
) =>
  Layer.mergeAll(
    NodeFileSystem.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    relayClientLayer,
    frpcLayer,
    Layer.effect(
      ManagedConnectorClients.ManagedConnectorClients,
      Effect.all({
        cloudflared: RelayClient.RelayClient,
        frpc: FrpcClient.FrpcClient,
      }).pipe(
        Effect.map(({ cloudflared, frpc }) =>
          ManagedConnectorClients.make({ cloudflare_tunnel: cloudflared, t3_relay: frpc }),
        ),
      ),
    ).pipe(Layer.provideMerge(relayClientLayer), Layer.provideMerge(frpcLayer)),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeed(Option.none()),
    }),
  );

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = relayClientAvailableLayer,
  frpcLayer = frpcClientAvailableLayer,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(runtimeDependencies(spawner, relayClientLayer, frpcLayer)),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

function makeHandle(input: {
  readonly pid: number;
  readonly onKill: () => void;
  readonly isRunning?: () => boolean;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly all?: Stream.Stream<Uint8Array>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: () =>
      Effect.sync(() => {
        input.onKill();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: input.all ?? Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("CloudManagedEndpointRuntime", () => {
  it("classifies Cloudflare connection and warning output", () => {
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0",
      ),
    ).toBe("connected");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z ERR Failed to serve tunnel connection",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Starting metrics server",
      ),
    ).toBe("debug");
    // FTL (fatal) and PNC (panic) are more severe than ERR and must surface.
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z FTL Cannot determine default origin certificate path",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput("2026-06-17T02:00:00Z PNC runtime panic"),
    ).toBe("warning");
  });

  it("classifies frpc route readiness and failures", () => {
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "[I] [proxy.go:204] [environment] start proxy success",
        "t3_relay",
      ),
    ).toBe("connected");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "[W] [service.go:179] login to server failed: authorization denied",
        "t3_relay",
      ),
    ).toBe("disconnected");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "[W] [client/service.go:322] connect to server error: connector not authorized",
        "t3_relay",
      ),
    ).toBe("authorization_rejected");
  });

  it.effect("stops frpc and emits one terminal event when relay authorization is rejected", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 250 + spawned.length;
          spawned.push(pid);
          const handle = makeHandle({
            pid,
            all: Stream.make(
              new TextEncoder().encode(
                "[W] [client/service.go:322] connect to server error: connector not authorized\n",
              ),
            ).pipe(Stream.concat(Stream.never)),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "t3_relay",
        connectorId: "connector-id",
        connectorToken: "connector-token",
        serverAddr: "connect.example.test",
        serverPort: 443,
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
        localHttpHost: "127.0.0.1",
        localHttpPort: 3773,
      });
      const rejection = yield* runtime.takeAuthorizationRejection;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 minutes");

      expect(rejection).toEqual({
        providerKind: "t3_relay",
        connectorId: "connector-id",
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
      });
      expect(spawned).toEqual([250]);
      expect(killed).toEqual([250]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("starts, deduplicates, rotates, and stops the Cloudflare connector", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.StandardCommand> = [];
      const killed: Array<number> = [];
      let nextPid = 100;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected standard command.");
          }
          spawned.push(command);
          const pid = nextPid;
          nextPid += 1;
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-2",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      const stopped = yield* runtime.applyConfig(null);

      expect(spawned.map((command) => command.command)).toEqual(["cloudflared", "cloudflared"]);
      expect(spawned.map((command) => command.args)).toEqual([
        ["tunnel", "run"],
        ["tunnel", "run"],
      ]);
      expect(spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
        "token-1",
        "token-2",
      ]);
      expect(spawned.map((command) => command.options.stdout)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.stderr)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.detached)).toEqual([false, false]);
      expect(spawned.map((command) => command.options.shell)).toEqual([false, false]);
      expect(killed).toEqual([100, 101]);
      expect(stopped).toEqual({ status: "disabled" });
    }),
  );

  it.effect("rotates to frpc using an owner-only temporary config and no argv or env secret", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const killed: Array<number> = [];
      const spawned: Array<ChildProcess.StandardCommand> = [];
      let frpcConfigPath: string | undefined;
      let frpcConfigContents: string | undefined;
      let frpcConfigMode: number | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected standard command.");
          }
          spawned.push(command);
          const pid = spawned.length === 1 ? 200 : 201;
          if (command.command === "frpc") {
            const configPath = command.args[1];
            if (!configPath) throw new Error("Expected an frpc config path.");
            frpcConfigPath = configPath;
            frpcConfigContents = yield* fileSystem.readFileString(configPath);
            frpcConfigMode = (yield* fileSystem.stat(configPath)).mode & 0o777;
          }
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      const sovereign = yield* runtime.applyConfig({
        providerKind: "t3_relay",
        connectorId: "environment-id",
        connectorToken: "connector-token",
        serverAddr: "connect.example.test",
        serverPort: 7000,
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
        localHttpHost: "127.0.0.1",
        localHttpPort: 3773,
      });
      yield* runtime.applyConfig(null);

      expect(started.status).toBe("running");
      expect(sovereign).toEqual({
        status: "running",
        providerKind: "t3_relay",
        pid: 201,
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
      });
      expect(spawned.map((command) => command.command)).toEqual(["cloudflared", "frpc"]);
      expect(spawned[1]?.args[0]).toBe("-c");
      expect(spawned[1]?.args.join(" ")).not.toContain("connector-token");
      expect(spawned[1]?.options.env?.TUNNEL_TOKEN).toBeUndefined();
      expect(frpcConfigContents).toContain('metadatas.t3_connector_token = "connector-token"');
      expect(frpcConfigContents).toContain('localIP = "127.0.0.1"');
      expect(frpcConfigMode).toBe(0o600);
      expect(frpcConfigPath).toBeDefined();
      expect(yield* fileSystem.exists(frpcConfigPath!)).toBe(false);
      expect(killed).toEqual([200, 201]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("restarts the connector when the active process has exited", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      let firstRunning = true;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 300 : 301;
          spawned.push(pid);
          const handle = makeHandle({
            pid,
            isRunning: () => (pid === 300 ? firstRunning : true),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      const first = yield* runtime.applyConfig(config);
      firstRunning = false;
      const second = yield* runtime.applyConfig(config);

      expect(first).toMatchObject({ status: "running", pid: 300 });
      expect(second).toMatchObject({ status: "running", pid: 301 });
      expect(spawned).toEqual([300, 301]);
      expect(killed).toEqual([300]);
    }),
  );

  it.effect("supervises the active connector and restarts it after process exit", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const secondSpawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 400 : 401;
          spawned.push(pid);
          if (pid === 401) {
            yield* Deferred.succeed(secondSpawned, undefined);
          }
          const handle = makeHandle({
            pid,
            exitCode:
              pid === 400
                ? Deferred.await(firstExit)
                : (Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
      yield* Effect.yieldNow;
      expect(spawned).toEqual([400]);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(secondSpawned);

      expect(started).toMatchObject({ status: "running", pid: 400 });
      expect(spawned).toEqual([400, 401]);
      expect(killed).toEqual([400]);
    }),
  );

  it.effect("records a transient relay disconnect and its recovery", () =>
    Effect.gen(function* () {
      const outputProcessed = yield* Deferred.make<void>();
      const connectorOutput = new TextEncoder().encode(
        [
          "[I] [proxy.go:204] [environment] start proxy success",
          "[W] [client/control.go:444] connection closed",
          "[I] [proxy.go:204] [environment] start proxy success",
          "",
        ].join("\n"),
      );
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 450,
            all: Stream.make(connectorOutput).pipe(
              Stream.ensuring(Deferred.succeed(outputProcessed, undefined)),
            ),
            onKill: () => undefined,
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "t3_relay",
        connectorId: "environment-id",
        connectorToken: "connector-token",
        serverAddr: "connect.example.test",
        serverPort: 443,
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
        localHttpHost: "127.0.0.1",
        localHttpPort: 3773,
      });
      yield* Deferred.await(outputProcessed);

      const snapshots = yield* Metric.snapshot;
      expect(
        hasMetricSnapshot(snapshots, "t3_relay_connector_events_total", {
          providerKind: "t3_relay",
          event: "transient_disconnect",
        }),
      ).toBe(true);
      expect(
        hasMetricSnapshot(snapshots, "t3_relay_connector_events_total", {
          providerKind: "t3_relay",
          event: "recovered",
        }),
      ).toBe(true);
      expect(
        hasMetricSnapshot(snapshots, "t3_relay_connector_recovery_duration", {
          providerKind: "t3_relay",
        }),
      ).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("serializes concurrent connector config changes", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstSpawnEntered = yield* Deferred.make<void>();
      const releaseFirstSpawn = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 500 + spawned.length;
          spawned.push(pid);
          if (pid === 500) {
            yield* Deferred.succeed(firstSpawnEntered, undefined);
            yield* Deferred.await(releaseFirstSpawn);
          }
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const first = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSpawnEntered);
      const second = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-2",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseFirstSpawn, undefined);

      yield* Fiber.join(first);
      const status = yield* Fiber.join(second);

      expect(status).toMatchObject({ status: "running", pid: 501 });
      expect(spawned).toEqual([500, 501]);
      expect(killed).toEqual([500]);
    }),
  );

  it.effect("reports connector spawn failures", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "cloudflared missing",
          }),
        ),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        tunnelId: "tunnel-1",
      });
    }),
  );

  it.effect("reports a missing relay client executable without spawning", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      const spawner = ChildProcessSpawner.make(spawn);
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused"),
            installWithProgress: () => Effect.die("unused"),
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      expect(status).toEqual({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason: "The relay client is not installed.",
      });
      expect(spawn).not.toHaveBeenCalled();
    }),
  );

  it.effect("installs frpc on first sovereign allocation without a separate UI flow", () =>
    Effect.gen(function* () {
      const installs: Array<string> = [];
      const spawned: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected standard command.");
          }
          spawned.push(command.command);
          const handle = makeHandle({ pid: 700, onKill: () => undefined });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const frpcLayer = Layer.succeed(
        FrpcClient.FrpcClient,
        FrpcClient.FrpcClient.of({
          resolve: Effect.succeed({ status: "missing", version: FrpcClient.FRPC_VERSION }),
          install: Effect.sync(() => {
            installs.push("frpc");
            return {
              status: "available" as const,
              executablePath: "managed-frpc",
              source: "managed" as const,
              version: FrpcClient.FRPC_VERSION,
            };
          }),
          installWithProgress: () => Effect.die("unused"),
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        relayClientAvailableLayer,
        frpcLayer,
      );

      const status = yield* runtime.applyConfig({
        providerKind: "t3_relay",
        connectorId: "environment-id",
        connectorToken: "connector-token",
        serverAddr: "connect.example.test",
        serverPort: 7000,
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
        localHttpHost: "127.0.0.1",
        localHttpPort: 3773,
      });

      expect(status).toMatchObject({
        status: "running",
        providerKind: "t3_relay",
        pid: 700,
      });
      expect(installs).toEqual(["frpc"]);
      expect(spawned).toEqual(["managed-frpc"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
