import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as ManagedConnectorClients from "@t3tools/shared/managedConnectorClients";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig } from "./config.ts";
import { renderFrpcConfig } from "./frpcConfig.ts";
import {
  ManagedEndpointRuntime,
  type ManagedEndpointRuntimeStatus,
} from "./ManagedEndpointRuntimeService.ts";

type ManagedConnectorConfig = Extract<
  RelayManagedEndpointRuntimeConfig,
  { readonly providerKind: "cloudflare_tunnel" | "t3_relay" }
>;

const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 30_000;

// Preserve the upstream service names while production consumers depend on the
// provider-neutral service contract directly.
export {
  ManagedEndpointRuntime as CloudManagedEndpointRuntime,
  type ManagedEndpointRuntimeStatus as CloudManagedEndpointRuntimeStatus,
} from "./ManagedEndpointRuntimeService.ts";

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const readRuntimeConfig = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bytes = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  if (Option.isNone(bytes)) {
    return null;
  }
  return Option.getOrNull(decodeRuntimeConfig(bytesToString(bytes.value)));
});

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: ManagedConnectorConfig;
}

export function classifyRelayClientOutput(
  line: string,
  providerKind: ManagedConnectorConfig["providerKind"] = "cloudflare_tunnel",
): "connected" | "warning" | "debug" {
  if (
    providerKind === "cloudflare_tunnel"
      ? /\bRegistered tunnel connection\b/iu.test(line)
      : /\bstart proxy success\b/iu.test(line)
  ) {
    return "connected";
  }
  // cloudflared uses zerolog level tokens. FTL (fatal) and PNC (panic) are more
  // severe than ERR, so they must surface at least as loudly — without them a
  // fatal connector failure would be logged at debug and hidden.
  return providerKind === "cloudflare_tunnel"
    ? /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line)
      ? "warning"
      : "debug"
    : /\b(?:error|warning|failed|panic|fatal)\b/iu.test(line)
      ? "warning"
      : "debug";
}

function runtimeConfigKey(config: ManagedConnectorConfig): string {
  return JSON.stringify(config);
}

function statusMetadata(config: ManagedConnectorConfig) {
  return config.providerKind === "cloudflare_tunnel"
    ? {
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      }
    : {
        proxyName: config.proxyName,
        hostname: config.hostname,
      };
}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Scope.close(connector.scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: Number(connector.child.pid),
          }),
        ),
        Effect.ignore,
      )
    : Effect.void;

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const connectorClients = yield* ManagedConnectorClients.ManagedConnectorClients;
  const runtimeScope = yield* Scope.Scope;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const restartStateRef = yield* Ref.make({ configKey: "", attempts: 0 });
  const reconcileSemaphore = yield* Semaphore.make(1);
  let reconcileConfig: ManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(connector.child.exitCode);
      const restart = yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* Ref.get(activeRef);
          if (
            active?.child.pid !== connector.child.pid ||
            active.configKey !== connector.configKey
          ) {
            return null;
          }
          yield* Ref.set(activeRef, null);
          yield* stopConnector(connector);

          const desiredConfig = yield* Ref.get(desiredConfigRef);
          if (
            !desiredConfig ||
            desiredConfig.providerKind === "manual" ||
            runtimeConfigKey(desiredConfig) !== connector.configKey
          ) {
            return null;
          }

          const restartState = yield* Ref.get(restartStateRef);
          const attempts =
            restartState.configKey === connector.configKey ? restartState.attempts + 1 : 1;
          yield* Ref.set(restartStateRef, { configKey: connector.configKey, attempts });
          const exponentialDelay = Math.min(
            RESTART_MAX_DELAY_MS,
            RESTART_BASE_DELAY_MS * 2 ** Math.min(attempts - 1, 16),
          );
          const jitter = 0.75 + (yield* Random.next) * 0.5;
          const restartDelayMs = Math.round(exponentialDelay * jitter);

          yield* Effect.logWarning("Relay client exited; restarting", {
            pid: Number(connector.child.pid),
            ...(Result.isSuccess(result)
              ? { exitCode: Number(result.success) }
              : { cause: result.failure }),
            providerKind: connector.config.providerKind,
            restartAttempt: attempts,
            restartDelayMs,
            ...statusMetadata(connector.config),
          });
          return { config: desiredConfig, configKey: connector.configKey, restartDelayMs };
        }),
      );
      if (!restart) return;

      yield* Effect.sleep(Duration.millis(restart.restartDelayMs));
      yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const desiredConfig = yield* Ref.get(desiredConfigRef);
          const active = yield* Ref.get(activeRef);
          if (
            active ||
            !desiredConfig ||
            desiredConfig.providerKind === "manual" ||
            runtimeConfigKey(desiredConfig) !== restart.configKey
          ) {
            return;
          }
          yield* reconcileConfig(restart.config);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay client supervisor failed", { cause })),
    );

  const observeConnectorOutput = (connector: ActiveConnector) =>
    connector.child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => {
        const output = line.replaceAll(connector.config.connectorToken, "<redacted>");
        const attributes = {
          pid: Number(connector.child.pid),
          providerKind: connector.config.providerKind,
          ...statusMetadata(connector.config),
          output,
        };
        switch (classifyRelayClientOutput(line, connector.config.providerKind)) {
          case "connected":
            return Ref.set(restartStateRef, {
              configKey: connector.configKey,
              attempts: 0,
            }).pipe(
              Effect.andThen(
                Effect.logInfo("Relay client tunnel connection registered", attributes),
              ),
            );
          case "warning":
            return Effect.logWarning("Relay client reported a transport warning", attributes);
          case "debug":
            return Effect.logDebug("Relay client output", attributes);
        }
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Relay client output observer failed", {
          cause,
          pid: Number(connector.child.pid),
          providerKind: connector.config.providerKind,
          ...statusMetadata(connector.config),
        }),
      ),
    );

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (config) {
    if (!config) {
      yield* stopActive;
      return { status: "disabled" };
    }
    if (config.providerKind === "manual") {
      yield* stopActive;
      return { status: "unsupported", providerKind: "manual" };
    }

    const nextConfigKey = runtimeConfigKey(config);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === nextConfigKey) {
      const isRunning = yield* active.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (isRunning) {
        return config.providerKind === "cloudflare_tunnel"
          ? ({
              status: "running",
              providerKind: "cloudflare_tunnel",
              pid: Number(active.child.pid),
              ...statusMetadata(config),
            } satisfies ManagedEndpointRuntimeStatus)
          : ({
              status: "running",
              providerKind: "t3_relay",
              pid: Number(active.child.pid),
              proxyName: config.proxyName,
              hostname: config.hostname,
            } satisfies ManagedEndpointRuntimeStatus);
      }
    }

    yield* stopActive;

    const connectorClient = yield* connectorClients.get(config.providerKind).pipe(Effect.option);
    if (Option.isNone(connectorClient)) {
      return {
        status: "unsupported",
        providerKind: config.providerKind,
      } satisfies ManagedEndpointRuntimeStatus;
    }

    let executable = yield* connectorClient.value.resolve;
    if (config.providerKind === "t3_relay" && executable.status === "missing") {
      yield* Effect.logInfo("Installing the sovereign relay client", {
        providerKind: config.providerKind,
        version: executable.version,
        ...statusMetadata(config),
      });
      const installed = yield* Effect.result(connectorClient.value.install);
      if (Result.isFailure(installed)) {
        return {
          status: "failed",
          providerKind: config.providerKind,
          reason: installed.failure.message,
          ...statusMetadata(config),
        } satisfies ManagedEndpointRuntimeStatus;
      }
      executable = installed.success;
    }
    if (executable.status !== "available") {
      return {
        status: "failed",
        providerKind: config.providerKind,
        reason:
          executable.status === "unsupported"
            ? `Relay client is unsupported on ${executable.platform}-${executable.arch}.`
            : "The relay client is not installed.",
        ...statusMetadata(config),
      } satisfies ManagedEndpointRuntimeStatus;
    }

    const connectorScope = yield* Scope.make("sequential");
    const processConfig = yield* Effect.gen(function* () {
      if (config.providerKind === "cloudflare_tunnel") {
        return {
          args: ["tunnel", "run"],
          env: {
            ...process.env,
            TUNNEL_TOKEN: config.connectorToken,
          },
        };
      }

      const configPath = yield* fileSystem.makeTempFileScoped({
        prefix: "t3-frpc-",
        suffix: ".toml",
      });
      yield* fileSystem.writeFileString(configPath, renderFrpcConfig(config));
      yield* fileSystem.chmod(configPath, 0o600);
      const { TUNNEL_TOKEN: _tunnelToken, ...env } = process.env;
      return {
        args: ["-c", configPath],
        env,
      };
    }).pipe(
      Effect.provideService(Scope.Scope, connectorScope),
      Effect.catch((cause) =>
        Scope.close(connectorScope, Exit.void).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.succeed({
              status: "failed" as const,
              providerKind: config.providerKind,
              reason: String(cause),
              ...statusMetadata(config),
            }),
          ),
        ),
      ),
    );

    if ("status" in processConfig) {
      return processConfig;
    }

    const child = yield* spawner
      .spawn(
        ChildProcess.make(executable.executablePath, processConfig.args, {
          detached: false,
          env: processConfig.env,
          shell: false,
          stderr: "pipe",
          stdout: "pipe",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, connectorScope),
        Effect.tap((child) =>
          Effect.logInfo("Relay client process started; waiting for tunnel connection", {
            pid: Number(child.pid),
            providerKind: config.providerKind,
            ...statusMetadata(config),
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to start relay client", {
            cause,
            providerKind: config.providerKind,
            ...statusMetadata(config),
          }).pipe(
            Effect.andThen(Scope.close(connectorScope, Exit.void).pipe(Effect.ignore)),
            Effect.as({
              status: "failed",
              providerKind: config.providerKind,
              reason: String(cause),
              ...statusMetadata(config),
            } satisfies ManagedEndpointRuntimeStatus),
          ),
        ),
      );

    if ("status" in child && child.status === "failed") {
      return child;
    }

    if (!("status" in child)) {
      const connector = {
        child,
        scope: connectorScope,
        configKey: nextConfigKey,
        config,
      } satisfies ActiveConnector;
      yield* Ref.set(activeRef, connector);
      yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
      yield* Effect.forkIn(superviseConnector(connector), runtimeScope);
      return config.providerKind === "cloudflare_tunnel"
        ? ({
            status: "running",
            providerKind: "cloudflare_tunnel",
            pid: Number(child.pid),
            ...statusMetadata(config),
          } satisfies ManagedEndpointRuntimeStatus)
        : ({
            status: "running",
            providerKind: "t3_relay",
            pid: Number(child.pid),
            proxyName: config.proxyName,
            hostname: config.hostname,
          } satisfies ManagedEndpointRuntimeStatus);
    }

    return {
      status: "failed",
      providerKind: config.providerKind,
      reason: "Relay client did not start.",
      ...statusMetadata(config),
    } satisfies ManagedEndpointRuntimeStatus;
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: RelayManagedEndpointRuntimeConfig | null) =>
      reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(desiredConfigRef);
          const previousKey =
            previous && previous.providerKind !== "manual" ? runtimeConfigKey(previous) : null;
          const nextKey =
            config && config.providerKind !== "manual" ? runtimeConfigKey(config) : null;
          if (previousKey !== nextKey) {
            yield* Ref.set(restartStateRef, { configKey: nextKey ?? "", attempts: 0 });
          }
          yield* Ref.set(desiredConfigRef, config);
          return yield* reconcileConfig(config);
        }),
      ),
  );

  const runtime = ManagedEndpointRuntime.of({
    applyConfig,
  });

  const initialConfig = yield* readRuntimeConfig.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read managed endpoint runtime config", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );
  yield* runtime.applyConfig(initialConfig);
  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(ManagedEndpointRuntime, make);
