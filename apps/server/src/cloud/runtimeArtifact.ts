// @effect-diagnostics nodeBuiltinImport:off -- Streaming a multi-gigabyte signed archive to an exclusive file requires Node streams.
// @effect-diagnostics globalFetch:off -- Native fetch exposes the streamed Web response consumed by the Node pipeline below.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export const RUNTIME_ARTIFACT_SOURCE_FILE = "artifact-source.json";
export const RUNTIME_ARTIFACT_PROVENANCE_FILE = ".runtime-artifact.json";
const MAX_MANIFEST_BYTES = 128 * 1_024;
const MAX_ARTIFACT_BYTES = 2 * 1_024 * 1_024 * 1_024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

const RegistryRuntimeArtifactSourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  baseUrl: Schema.String,
  username: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  publicKeySpkiB64: Schema.String,
});

const ReleaseRuntimeArtifactSourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  releaseBaseUrl: Schema.String,
  publicKeySpkiB64: Schema.String,
});

const RuntimeArtifactSourceSchema = Schema.Union([
  RegistryRuntimeArtifactSourceSchema,
  ReleaseRuntimeArtifactSourceSchema,
]);

const RuntimeArtifactPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.String,
  platform: Schema.Literals(["linux"]),
  arch: Schema.Literals(["x64", "arm64"]),
  fileName: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  commit: Schema.String,
});

const RuntimeArtifactEnvelopeSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  payload: Schema.String,
  signature: Schema.String,
});

const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeArtifactSourceSchema));
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeArtifactEnvelopeSchema),
);
const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeArtifactPayloadSchema),
);

export type RuntimeArtifactSource = typeof RuntimeArtifactSourceSchema.Type;
export type RuntimeArtifactPayload = typeof RuntimeArtifactPayloadSchema.Type;

export class RuntimeArtifactError extends Schema.TaggedErrorClass<RuntimeArtifactError>()(
  "RuntimeArtifactError",
  {
    step: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Sovereign runtime artifact failed while ${this.step}.`;
  }
}

const isRuntimeArtifactError = Schema.is(RuntimeArtifactError);

const fail = (step: string, cause?: unknown) =>
  cause === undefined
    ? new RuntimeArtifactError({ step })
    : new RuntimeArtifactError({ step, cause });

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw fail(`decoding the ${label}`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw fail(`decoding the ${label}`);
  }
  return decoded;
}

function validateSource(source: RuntimeArtifactSource): RuntimeArtifactSource {
  const url = new URL(source.schemaVersion === 1 ? source.baseUrl : source.releaseBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw fail("validating the artifact source URL");
  }
  if (source.schemaVersion === 1) {
    const hasUsername = source.username !== undefined && source.username.trim().length > 0;
    const hasToken = source.token !== undefined && source.token.length > 0;
    if (hasUsername !== hasToken) throw fail("validating artifact source credentials");
  }
  decodeCanonicalBase64(source.publicKeySpkiB64, "artifact signing public key");
  return source;
}

export function runtimeArtifactSourcePath(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, "runtime", RUNTIME_ARTIFACT_SOURCE_FILE);
}

export const hasRuntimeArtifactProvenance = Effect.fn("cloud.runtime_artifact.has_provenance")(
  function* (input: {
    readonly versionDir: string;
    readonly version: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const provenance = yield* input.fs
      .readFileString(input.path.join(input.versionDir, RUNTIME_ARTIFACT_PROVENANCE_FILE))
      .pipe(Effect.option);
    if (Option.isNone(provenance)) return false;
    return yield* decodePayload(provenance.value).pipe(
      Effect.map(
        (payload) =>
          payload.version === input.version &&
          payload.platform === platform &&
          payload.arch === arch &&
          payload.fileName === `t3-sovereign-runtime-${platform}-${arch}.tar.gz`,
      ),
      Effect.catch(() => Effect.succeed(false)),
    );
  },
);

export const loadRuntimeArtifactSource = Effect.fn("cloud.runtime_artifact.load_source")(
  function* (input: {
    readonly baseDir: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const sourcePath = runtimeArtifactSourcePath(input.path, input.baseDir);
    const exists = yield* input.fs
      .exists(sourcePath)
      .pipe(
        Effect.mapError((cause) => fail("checking for sovereign artifact configuration", cause)),
      );
    if (!exists) return Option.none<RuntimeArtifactSource>();
    const text = yield* input.fs
      .readFileString(sourcePath)
      .pipe(Effect.mapError((cause) => fail("reading sovereign artifact configuration", cause)));
    const source = yield* decodeSource(text).pipe(
      Effect.mapError((cause) => fail("decoding sovereign artifact configuration", cause)),
    );
    return Option.some(
      yield* Effect.try({
        try: () => validateSource(source),
        catch: (cause) =>
          isRuntimeArtifactError(cause)
            ? cause
            : fail("validating sovereign artifact configuration", cause),
      }),
    );
  },
);

export const verifyRuntimeArtifactEnvelope = Effect.fn("cloud.runtime_artifact.verify_manifest")(
  function* (input: {
    readonly envelopeText: string;
    readonly publicKeySpkiB64: string;
    readonly version: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  }) {
    const envelope = yield* decodeEnvelope(input.envelopeText).pipe(
      Effect.mapError((cause) => fail("decoding the signed artifact manifest", cause)),
    );
    const payloadBytes = yield* Effect.try({
      try: () => decodeCanonicalBase64(envelope.payload, "artifact manifest payload"),
      catch: (cause) =>
        isRuntimeArtifactError(cause)
          ? cause
          : fail("decoding the artifact manifest payload", cause),
    });
    const signature = yield* Effect.try({
      try: () => decodeCanonicalBase64(envelope.signature, "artifact manifest signature"),
      catch: (cause) =>
        isRuntimeArtifactError(cause)
          ? cause
          : fail("decoding the artifact manifest signature", cause),
    });
    const publicKey = yield* Effect.try({
      try: () =>
        NodeCrypto.createPublicKey({
          key: decodeCanonicalBase64(input.publicKeySpkiB64, "artifact signing public key"),
          format: "der",
          type: "spki",
        }),
      catch: (cause) =>
        isRuntimeArtifactError(cause)
          ? cause
          : fail("loading the artifact signing public key", cause),
    });
    if (!NodeCrypto.verify(null, payloadBytes, publicKey, signature)) {
      return yield* fail("verifying the artifact manifest signature");
    }
    const payload = yield* decodePayload(payloadBytes.toString("utf8")).pipe(
      Effect.mapError((cause) => fail("decoding the verified artifact manifest", cause)),
    );
    if (
      payload.version !== input.version ||
      payload.platform !== input.platform ||
      payload.arch !== input.arch ||
      payload.fileName !== `t3-sovereign-runtime-${payload.platform}-${payload.arch}.tar.gz` ||
      !/^[a-f0-9]{64}$/u.test(payload.sha256) ||
      !Number.isSafeInteger(payload.sizeBytes) ||
      payload.sizeBytes <= 0 ||
      payload.sizeBytes > MAX_ARTIFACT_BYTES ||
      !/^[a-f0-9]{7,64}$/u.test(payload.commit)
    ) {
      return yield* fail("validating the verified artifact manifest");
    }
    return payload;
  },
);

function artifactRequestHeaders(source: RuntimeArtifactSource): Record<string, string> {
  if (source.schemaVersion === 2 || source.username === undefined || source.token === undefined) {
    return {};
  }
  return {
    Authorization: `Basic ${Buffer.from(`${source.username}:${source.token}`, "utf8").toString("base64")}`,
  };
}

function artifactUrl(source: RuntimeArtifactSource, version: string, fileName: string): URL {
  const sourceBaseUrl = source.schemaVersion === 1 ? source.baseUrl : source.releaseBaseUrl;
  const baseUrl = sourceBaseUrl.endsWith("/") ? sourceBaseUrl : `${sourceBaseUrl}/`;
  const versionPath =
    source.schemaVersion === 1
      ? encodeURIComponent(version)
      : `runtime-${encodeURIComponent(version)}`;
  return new URL(`${versionPath}/${encodeURIComponent(fileName)}`, baseUrl);
}

async function fetchChecked(
  source: RuntimeArtifactSource,
  version: string,
  fileName: string,
): Promise<Response> {
  const response = await fetch(artifactUrl(source, version, fileName), {
    headers: artifactRequestHeaders(source),
    // GitHub Releases redirects immutable asset URLs to its asset CDN. The
    // signed manifest and archive digest remain the authority for the bytes.
    redirect: source.schemaVersion === 1 ? "error" : "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`artifact registry returned HTTP ${response.status}`);
  if (new URL(response.url).protocol !== "https:") {
    throw new Error("artifact download redirected away from HTTPS");
  }
  return response;
}

async function readManifestResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_MANIFEST_BYTES) throw new Error("artifact manifest is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("artifact manifest is too large");
  return new TextDecoder().decode(bytes);
}

async function downloadArtifact(
  response: Response,
  destination: string,
  payload: RuntimeArtifactPayload,
): Promise<void> {
  if (response.body === null) throw new Error("artifact response had no body");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 0 && contentLength !== payload.sizeBytes) {
    throw new Error("artifact content length does not match its signed manifest");
  }
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  const meter = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > payload.sizeBytes || bytes > MAX_ARTIFACT_BYTES) {
        callback(new Error("artifact exceeded its signed size"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body as Parameters<typeof NodeStream.Readable.fromWeb>[0]),
    meter,
    NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== payload.sizeBytes || hash.digest("hex") !== payload.sha256) {
    throw new Error("artifact bytes do not match the signed manifest");
  }
}

export const installRuntimeArtifact = Effect.fn("cloud.runtime_artifact.install")(
  function* (input: {
    readonly source: RuntimeArtifactSource;
    readonly baseDir: string;
    readonly version: string;
    readonly stagingDir: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly runner: ProcessRunner.ProcessRunner["Service"];
  }) {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    if (platform !== "linux" || !["x64", "arm64"].includes(arch)) {
      return yield* fail(`selecting an artifact for ${platform}-${arch}`);
    }
    const manifestName = `${platform}-${arch}.manifest.json`;
    const envelopeText = yield* Effect.tryPromise({
      try: () => fetchChecked(input.source, input.version, manifestName).then(readManifestResponse),
      catch: (cause) => fail("downloading the signed artifact manifest", cause),
    });
    const payload = yield* verifyRuntimeArtifactEnvelope({
      envelopeText,
      publicKeySpkiB64: input.source.publicKeySpkiB64,
      version: input.version,
      platform,
      arch,
    });
    const archivePath = input.path.join(input.stagingDir, ".runtime-artifact.tar.gz");
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchChecked(input.source, input.version, payload.fileName);
        await downloadArtifact(response, archivePath, payload);
      },
      catch: (cause) => fail("downloading and verifying the runtime artifact", cause),
    });
    const extracted = yield* input.runner
      .run({
        command: "tar",
        args: [
          "-xzf",
          archivePath,
          "-C",
          input.stagingDir,
          "--no-same-owner",
          "--no-same-permissions",
        ],
        timeout: Duration.minutes(5),
      })
      .pipe(Effect.mapError((cause) => fail("extracting the runtime artifact", cause)));
    if (extracted.code !== 0) return yield* fail("extracting the runtime artifact");
    yield* input.fs
      .remove(archivePath, { force: true })
      .pipe(Effect.mapError((cause) => fail("removing the verified artifact archive", cause)));
    yield* input.fs
      .writeFileString(
        input.path.join(input.stagingDir, RUNTIME_ARTIFACT_PROVENANCE_FILE),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - payload was decoded by RuntimeArtifactPayloadSchema above.
        `${JSON.stringify(payload)}\n`,
        { mode: 0o600 },
      )
      .pipe(Effect.mapError((cause) => fail("recording artifact provenance", cause)));

    const bundledFrpcPath = input.path.join(
      input.stagingDir,
      "tools",
      "frpc",
      "0.70.1",
      `${platform}-${arch}`,
      "frpc",
    );
    if (yield* input.fs.exists(bundledFrpcPath)) {
      const frpcValidation = yield* input.runner
        .run({
          command: bundledFrpcPath,
          args: ["--version"],
          timeout: Duration.seconds(30),
        })
        .pipe(Effect.mapError((cause) => fail("validating the bundled FRP client", cause)));
      if (frpcValidation.code !== 0 || !frpcValidation.stdout.includes("0.70.1")) {
        return yield* fail("validating the bundled FRP client");
      }
      const managedFrpcPath = input.path.join(
        input.baseDir,
        "tools",
        "frpc",
        "0.70.1",
        `${platform}-${arch}`,
        "frpc",
      );
      yield* input.fs.makeDirectory(input.path.dirname(managedFrpcPath), { recursive: true });
      const stagedFrpcPath = `${managedFrpcPath}.${input.version}.tmp`;
      yield* input.fs.copyFile(bundledFrpcPath, stagedFrpcPath);
      yield* input.fs.chmod(stagedFrpcPath, 0o755);
      yield* input.fs
        .rename(stagedFrpcPath, managedFrpcPath)
        .pipe(
          Effect.ensuring(input.fs.remove(stagedFrpcPath, { force: true }).pipe(Effect.ignore)),
        );
    }
  },
);
