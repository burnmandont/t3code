import * as NodeCrypto from "node:crypto";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  hasRuntimeArtifactProvenance,
  isSupportedRuntimeArtifactTarget,
  loadRuntimeArtifactSource,
  runtimeArtifactSourcePath,
  verifyRuntimeArtifactEnvelope,
} from "./runtimeArtifact.ts";

function fixture(overrides: Partial<Record<string, unknown>> = {}) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      version: "0.0.32-sovereign.gabc1234",
      platform: "linux",
      arch: "x64",
      fileName: "t3-sovereign-runtime-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      commit: "abc1234",
      ...overrides,
    }),
  );
  return {
    envelopeText: JSON.stringify({
      schemaVersion: 1,
      payload: payload.toString("base64"),
      signature: NodeCrypto.sign(null, payload, privateKey).toString("base64"),
    }),
    publicKeySpkiB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

it.effect("verifies a signed sovereign runtime manifest", () =>
  Effect.gen(function* () {
    const input = fixture();
    const payload = yield* verifyRuntimeArtifactEnvelope({
      ...input,
      version: "0.0.32-sovereign.gabc1234",
      platform: "linux",
      arch: "x64",
    });
    assert.equal(payload.commit, "abc1234");
    assert.equal(payload.sizeBytes, 1024);
  }),
);

it.effect("verifies a signed Darwin arm64 runtime manifest", () =>
  Effect.gen(function* () {
    const input = fixture({
      platform: "darwin",
      arch: "arm64",
      fileName: "t3-sovereign-runtime-darwin-arm64.tar.gz",
    });
    const payload = yield* verifyRuntimeArtifactEnvelope({
      ...input,
      version: "0.0.32-sovereign.gabc1234",
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(payload.platform, "darwin");
    assert.equal(payload.arch, "arm64");
  }),
);

it("selects only published sovereign runtime targets", () => {
  assert.isTrue(isSupportedRuntimeArtifactTarget("linux", "x64"));
  assert.isTrue(isSupportedRuntimeArtifactTarget("linux", "arm64"));
  assert.isTrue(isSupportedRuntimeArtifactTarget("darwin", "arm64"));
  assert.isFalse(isSupportedRuntimeArtifactTarget("darwin", "x64"));
  assert.isFalse(isSupportedRuntimeArtifactTarget("win32", "x64"));
});

it.effect("rejects a manifest signed by a different key", () =>
  Effect.gen(function* () {
    const input = fixture();
    const other = NodeCrypto.generateKeyPairSync("ed25519").publicKey;
    const error = yield* verifyRuntimeArtifactEnvelope({
      ...input,
      publicKeySpkiB64: other.export({ format: "der", type: "spki" }).toString("base64"),
      version: "0.0.32-sovereign.gabc1234",
      platform: "linux",
      arch: "x64",
    }).pipe(Effect.flip);
    assert.equal(error._tag, "RuntimeArtifactError");
  }),
);

it.effect("rejects a correctly signed artifact for the wrong requested version", () =>
  Effect.gen(function* () {
    const input = fixture();
    const error = yield* verifyRuntimeArtifactEnvelope({
      ...input,
      version: "0.0.32-sovereign.gdifferent",
      platform: "linux",
      arch: "x64",
    }).pipe(Effect.flip);
    assert.equal(error._tag, "RuntimeArtifactError");
  }),
);

it.layer(NodeServices.layer)("loads a credentialless external release source", (it) => {
  it.effect("accepts an HTTPS GitHub release base without package credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-artifact-source-test-" });
      const sourcePath = runtimeArtifactSourcePath(path, baseDir);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(
        sourcePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - test fixture for the persisted source document.
        JSON.stringify({
          schemaVersion: 2,
          releaseBaseUrl: "https://github.com/moondiner/t3-runtime/releases/download",
          publicKeySpkiB64: NodeCrypto.generateKeyPairSync("ed25519")
            .publicKey.export({ format: "der", type: "spki" })
            .toString("base64"),
        }),
      );
      const source = yield* loadRuntimeArtifactSource({ baseDir, fs, path });
      assert.equal(source._tag, "Some");
      if (source._tag === "Some") {
        const value = source.value;
        assert.equal(value.schemaVersion, 2);
        if (value.schemaVersion !== 2) return;
        assert.equal(
          value.releaseBaseUrl,
          "https://github.com/moondiner/t3-runtime/releases/download",
        );
      }
    }),
  );

  it.effect("recognizes a bootstrap-installed Darwin runtime artifact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-darwin-runtime-test-" });
      const versionDir = path.join(baseDir, "runtime", "versions", "1.2.3-sovereign.gabc1234");
      yield* fs.makeDirectory(versionDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(versionDir, ".runtime-artifact.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - persisted signed payload fixture.
        `${JSON.stringify({
          schemaVersion: 1,
          version: "1.2.3-sovereign.gabc1234",
          platform: "darwin",
          arch: "arm64",
          fileName: "t3-sovereign-runtime-darwin-arm64.tar.gz",
          sha256: "a".repeat(64),
          sizeBytes: 1024,
          commit: "abc1234",
        })}\n`,
      );

      const present = yield* hasRuntimeArtifactProvenance({
        versionDir,
        version: "1.2.3-sovereign.gabc1234",
        fs,
        path,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessArchitecture, "arm64"),
      );
      assert.isTrue(present);
    }),
  );
});
