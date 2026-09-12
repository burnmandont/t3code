import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { verifySignedEnvelope } from "./artifact-format.mjs";
import {
  assertCompleteRuntimeRelease,
  createStableChannelEnvelope,
  resolveRuntimeOutputDirs,
} from "./publish-github-runtime.mjs";

NodeTest.test("signs the stable channel to the exact commit-addressed runtime", () => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const privateKeyPkcs8B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const channel = createStableChannelEnvelope({
    version: "0.0.32+sovereign.ga05daf26aad0",
    commit: "a05daf26aad0123456789",
    privateKeyPkcs8B64,
  });
  NodeAssert.deepEqual(verifySignedEnvelope(channel.envelope, channel.publicKeySpkiB64), {
    schemaVersion: 1,
    channel: "stable",
    version: "0.0.32+sovereign.ga05daf26aad0",
    commit: "a05daf26aad0123456789",
  });
});

NodeTest.test("refuses to point stable at a version from another commit", () => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  NodeAssert.throws(
    () =>
      createStableChannelEnvelope({
        version: "0.0.32+sovereign.ga05daf26aad0",
        commit: "bbbbbbbbbbbb123456789",
        privateKeyPkcs8B64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      }),
    /does not match/u,
  );
});

NodeTest.test("requires every supported platform before stable publication", () => {
  const complete = {
    assets: [
      "linux-x64.manifest.json",
      "t3-sovereign-runtime-linux-x64.tar.gz",
      "darwin-arm64.manifest.json",
      "t3-sovereign-runtime-darwin-arm64.tar.gz",
    ].map((name) => ({ name })),
  };
  NodeAssert.doesNotThrow(() => assertCompleteRuntimeRelease(complete));
  NodeAssert.throws(
    () => assertCompleteRuntimeRelease({ assets: complete.assets.slice(0, 2) }),
    /darwin-arm64/u,
  );
});

NodeTest.test("publishes platform output directories together without duplicates", () => {
  NodeAssert.deepEqual(
    resolveRuntimeOutputDirs(
      "infra/sovereign/dist/runtime",
      ["infra/sovereign/dist/runtime-darwin", "infra/sovereign/dist/runtime"].join(
        NodePath.delimiter,
      ),
    ),
    [
      NodePath.resolve("infra/sovereign/dist/runtime"),
      NodePath.resolve("infra/sovereign/dist/runtime-darwin"),
    ],
  );
});
