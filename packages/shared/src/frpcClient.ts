import type {
  RelayClientInstallProgressEvent,
  RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";
import {
  RelayClientInstallError,
  type AvailableRelayClient,
  type RelayClientShape,
} from "./connectorClient.ts";

export const FRPC_VERSION = "0.70.1";
export const FRPC_PATH_ENV_NAME = "T3CODE_FRPC_PATH";

export interface FrpcReleaseAsset {
  readonly url: string;
  readonly sha256: string;
  readonly archivePath: string;
}

const FRPC_RELEASE_ASSETS: Readonly<
  Partial<Record<`${NodeJS.Platform}-${string}`, FrpcReleaseAsset>>
> = {
  "darwin-arm64": {
    url: "https://github.com/fatedier/frp/releases/download/v0.70.1/frp_0.70.1_darwin_arm64.tar.gz",
    sha256: "cfa733b5a261c1647edee3c1fc4133d2542989b28f5602e81d47fc821d25c55f",
    archivePath: "frp_0.70.1_darwin_arm64/frpc",
  },
  "darwin-x64": {
    url: "https://github.com/fatedier/frp/releases/download/v0.70.1/frp_0.70.1_darwin_amd64.tar.gz",
    sha256: "cbf69cf26e5553e914e97d37f5d4367fa30f5f531d073a889465af4719281e25",
    archivePath: "frp_0.70.1_darwin_amd64/frpc",
  },
  "linux-arm64": {
    url: "https://github.com/fatedier/frp/releases/download/v0.70.1/frp_0.70.1_linux_arm64.tar.gz",
    sha256: "3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d",
    archivePath: "frp_0.70.1_linux_arm64/frpc",
  },
  "linux-x64": {
    url: "https://github.com/fatedier/frp/releases/download/v0.70.1/frp_0.70.1_linux_amd64.tar.gz",
    sha256: "333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6",
    archivePath: "frp_0.70.1_linux_amd64/frpc",
  },
};

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;

const trimmedString = (name: string) =>
  Config.string(name).pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const FrpcConfig = Config.all({
  executableOverride: trimmedString(FRPC_PATH_ENV_NAME),
  path: trimmedString("PATH"),
});

export interface FrpcClientOptions {
  readonly baseDir: string;
  readonly releaseAsset?: FrpcReleaseAsset;
}

export class FrpcClient extends Context.Service<FrpcClient, RelayClientShape>()(
  "@t3tools/shared/frpcClient",
) {}

class FrpcCommandError extends Data.TaggedError("FrpcCommandError")<{
  readonly command: string;
  readonly exitCode: number;
}> {}

function resolveReleaseAsset(platform: NodeJS.Platform, arch: string): FrpcReleaseAsset | null {
  return FRPC_RELEASE_ASSETS[`${platform}-${arch}`] ?? null;
}

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

const wrapInstallFailure =
  (
    reason: RelayClientInstallError["reason"],
    message: string,
  ): (<E, R>(
    effect: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, RelayClientInstallError, R>) =>
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason,
            message,
            cause,
          }),
      ),
    );

export const makeFrpcClient = Effect.fn("frpc.make")(function* (
  options: FrpcClientOptions,
): Effect.fn.Return<
  RelayClientShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installSemaphore = yield* Semaphore.make(1);
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const releaseAsset = options.releaseAsset ?? resolveReleaseAsset(platform, arch);
  const loadConfig = Effect.suspend(() => FrpcConfig).pipe(Effect.orDie);
  const executableName = platform === "win32" ? "frpc.exe" : "frpc";
  const managedPath = path.join(
    options.baseDir,
    "tools",
    "frpc",
    FRPC_VERSION,
    `${platform}-${arch}`,
    executableName,
  );

  const isExecutableFile = Effect.fn("frpc.isExecutableFile")(function* (executablePath: string) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return false;
    return platform === "win32" || (info.value.mode & 0o111) !== 0;
  });

  const resolvePathExecutable = Effect.gen(function* () {
    const config = yield* loadConfig;
    const pathValue = Option.getOrUndefined(config.path);
    if (!pathValue) return null;
    const delimiter = platform === "win32" ? ";" : ":";
    for (const directory of pathValue.split(delimiter)) {
      const trimmed = directory.trim().replace(/^"|"$/gu, "");
      if (trimmed.length === 0) continue;
      const candidate = path.join(trimmed, executableName);
      if (yield* isExecutableFile(candidate)) return candidate;
    }
    return null;
  });

  const resolve: RelayClientShape["resolve"] = Effect.gen(function* () {
    const config = yield* loadConfig;
    if (Option.isSome(config.executableOverride)) {
      return (yield* isExecutableFile(config.executableOverride.value))
        ? {
            status: "available",
            executablePath: config.executableOverride.value,
            source: "override",
            version: FRPC_VERSION,
          }
        : { status: "missing", version: FRPC_VERSION };
    }
    if (yield* isExecutableFile(managedPath)) {
      return {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: FRPC_VERSION,
      };
    }
    const pathExecutable = yield* resolvePathExecutable;
    if (pathExecutable) {
      return {
        status: "available",
        executablePath: pathExecutable,
        source: "path",
        version: FRPC_VERSION,
      };
    }
    return releaseAsset
      ? { status: "missing", version: FRPC_VERSION }
      : {
          status: "unsupported",
          platform,
          arch,
          version: FRPC_VERSION,
        };
  });

  const runCommand = Effect.fn("frpc.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        shell: false,
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new FrpcCommandError({ command, exitCode });
    }
  });

  const downloadAsset = Effect.fn("frpc.downloadAsset")(function* (
    asset: FrpcReleaseAsset,
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("downloading");
    const response = yield* httpClient.execute(HttpClientRequest.get(asset.url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason: "download_failed",
            message: "Could not download frpc.",
            cause,
          }),
      ),
    );
    const bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) =>
            new RelayClientInstallError({
              reason: "download_failed",
              message: "Could not read the downloaded frpc archive.",
              cause,
            }),
        ),
      ),
    );
    yield* report("verifying");
    const checksum = yield* crypto.digest("SHA-256", bytes).pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason: "validation_failed",
            message: "Could not verify the downloaded frpc checksum.",
            cause,
          }),
      ),
    );
    if (Encoding.encodeHex(checksum) !== asset.sha256) {
      return yield* new RelayClientInstallError({
        reason: "invalid_checksum",
        message: "Downloaded frpc checksum did not match the pinned release.",
      });
    }
    return bytes;
  });

  const acquireInstallLock = Effect.fn("frpc.acquireInstallLock")(function* (lockPath: string) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (acquired) return;

      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_STALE_MS) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      yield* Effect.sleep(INSTALL_LOCK_RETRY_DELAY);
    }
    return yield* new RelayClientInstallError({
      reason: "install_locked",
      message: "Another frpc installation is still in progress.",
    });
  });

  const installUnlocked = Effect.fn("frpc.installUnlocked")(function* (
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("checking");
    const existing = yield* resolve;
    if (existing.status === "available") return existing;
    const config = yield* loadConfig;
    if (Option.isSome(config.executableOverride)) {
      return yield* new RelayClientInstallError({
        reason: "override_missing",
        message: `${FRPC_PATH_ENV_NAME} does not point to an executable file.`,
      });
    }
    if (!releaseAsset) {
      return yield* new RelayClientInstallError({
        reason: "unsupported_platform",
        message: `Sovereign does not provide a managed frpc binary for ${platform}-${arch}.`,
      });
    }

    const managedDirectory = path.dirname(managedPath);
    const lockPath = `${managedPath}.lock`;
    yield* fileSystem
      .makeDirectory(managedDirectory, { recursive: true })
      .pipe(wrapInstallFailure("write_failed", "Could not create the frpc tool directory."));
    yield* report("waiting_for_lock");
    yield* acquireInstallLock(lockPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new RelayClientInstallError({
            reason: "write_failed",
            message: "Could not acquire the frpc installation lock.",
            cause,
          }),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const afterLock = yield* resolve;
      if (afterLock.status === "available") return afterLock;

      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(tempDirectory, "frpc.tar.gz");
      const download = yield* downloadAsset(releaseAsset, report);
      yield* report("installing");
      yield* fileSystem
        .writeFile(archivePath, download)
        .pipe(wrapInstallFailure("write_failed", "Could not write the frpc download."));
      yield* runCommand("tar", ["-xzf", archivePath, "-C", tempDirectory]).pipe(
        wrapInstallFailure("write_failed", "Could not extract frpc."),
      );

      const extractedPath = path.join(tempDirectory, releaseAsset.archivePath);
      yield* fileSystem
        .chmod(extractedPath, 0o755)
        .pipe(wrapInstallFailure("write_failed", "Could not make frpc executable."));
      yield* report("validating");
      yield* runCommand(extractedPath, ["--version"]).pipe(
        wrapInstallFailure("validation_failed", "The downloaded frpc binary did not run."),
      );

      const stagedPath = `${managedPath}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* report("activating");
      yield* fileSystem
        .rename(extractedPath, stagedPath)
        .pipe(wrapInstallFailure("write_failed", "Could not stage frpc."));
      yield* fileSystem
        .rename(stagedPath, managedPath)
        .pipe(
          wrapInstallFailure("write_failed", "Could not activate frpc."),
          Effect.ensuring(fileSystem.remove(stagedPath, { force: true }).pipe(Effect.ignore)),
        );
      return {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: FRPC_VERSION,
      } satisfies AvailableRelayClient;
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.catch((cause) =>
        cause instanceof RelayClientInstallError
          ? Effect.fail(cause)
          : Effect.fail(
              new RelayClientInstallError({
                reason: "write_failed",
                message: "Could not install frpc.",
                cause,
              }),
            ),
      ),
    );
  });

  const installWithProgress: RelayClientShape["installWithProgress"] = (report) =>
    installSemaphore.withPermit(
      installUnlocked((stage) =>
        report({
          type: "progress",
          stage,
        }),
      ),
    );
  const install = installWithProgress(() => Effect.void);

  return FrpcClient.of({ resolve, install, installWithProgress });
});

export const layerFrpc = (options: FrpcClientOptions) =>
  Layer.effect(FrpcClient, makeFrpcClient(options));
