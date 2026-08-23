import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";
import { FRPC_PATH_ENV_NAME, FRPC_VERSION, makeFrpcClient } from "./frpcClient.ts";
import { RelayClientInstallError } from "./relayClient.ts";

const hostRuntimeLayer = (env: Record<string, string> = {}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessArchitecture, "x64"),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const makeHttpClientLayer = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

describe("FrpcClient", () => {
  it.effect("resolves an explicit executable override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-frpc-test-" });
      const overridePath = `${baseDir}/frpc-override`;
      yield* fileSystem.writeFileString(overridePath, "frpc");
      yield* fileSystem.chmod(overridePath, 0o755);
      const client = yield* makeFrpcClient({ baseDir });

      expect(
        yield* client.resolve.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { PATH: "", [FRPC_PATH_ENV_NAME]: overridePath },
            }),
          ),
        ),
      ).toEqual({
        status: "available",
        executablePath: overridePath,
        source: "override",
        version: FRPC_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new Uint8Array()),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.succeed(makeHandle())),
          ),
          hostRuntimeLayer(),
        ),
      ),
    ),
  );

  it.effect("downloads, verifies, validates, and atomically installs frpc", () => {
    const bytes = new TextEncoder().encode("test-frpc-archive");
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-frpc-test-" });
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected a standard command.");
          }
          commands.push({ command: command.command, args: command.args });
          if (command.command === "tar") {
            const destination = command.args[command.args.indexOf("-C") + 1];
            const extractedDirectory = `${destination}/fixture`;
            yield* fileSystem.makeDirectory(extractedDirectory);
            yield* fileSystem.writeFileString(`${extractedDirectory}/frpc`, "test-frpc-binary");
          }
          return makeHandle();
        }),
      );
      const client = yield* makeFrpcClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/frpc.tar.gz",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archivePath: "fixture/frpc",
        },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const progress: Array<string> = [];
      const installed = yield* client.installWithProgress((event) =>
        Effect.sync(() => {
          if (event.type === "progress") progress.push(event.stage);
        }),
      );
      const managedPath = `${baseDir}/tools/frpc/${FRPC_VERSION}/linux-x64/frpc`;

      expect(installed).toEqual({
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: FRPC_VERSION,
      });
      expect(new TextDecoder().decode(yield* fileSystem.readFile(managedPath))).toBe(
        "test-frpc-binary",
      );
      expect(commands[0]?.command).toBe("tar");
      expect(commands[1]?.command.endsWith("/fixture/frpc")).toBe(true);
      expect(commands[1]?.args).toEqual(["--version"]);
      expect(progress).toEqual([
        "checking",
        "waiting_for_lock",
        "downloading",
        "verifying",
        "installing",
        "validating",
        "activating",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, makeHttpClientLayer(bytes), hostRuntimeLayer()),
      ),
    );
  });

  it.effect("rejects a release archive whose checksum does not match", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-frpc-test-" });
      const client = yield* makeFrpcClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/frpc.tar.gz",
          sha256: Encoding.encodeHex(sha256(new TextEncoder().encode("expected"))),
          archivePath: "fixture/frpc",
        },
      });

      const error = yield* client.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new TextEncoder().encode("tampered")),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.succeed(makeHandle())),
          ),
          hostRuntimeLayer(),
        ),
      ),
    ),
  );
});
