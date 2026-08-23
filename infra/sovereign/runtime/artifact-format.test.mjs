import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";

import {
  createSignedEnvelope,
  deriveSovereignVersion,
  verifySignedEnvelope,
} from "./artifact-format.mjs";

NodeTest.test("derives a stable commit-addressed sovereign SemVer", () => {
  NodeAssert.equal(
    deriveSovereignVersion("0.0.32", "f0df24970d9c1234"),
    "0.0.32+sovereign.gf0df24970d9c",
  );
});

NodeTest.test("signs an exact manifest payload with Ed25519", () => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const privateKeyB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const payload = { schemaVersion: 1, version: "0.0.32+sovereign.gf0df24970d9c" };
  const signed = createSignedEnvelope(payload, privateKeyB64);
  NodeAssert.deepEqual(verifySignedEnvelope(signed.envelope, signed.publicKeySpkiB64), payload);
});

NodeTest.test("rejects a signature from another key", () => {
  const first = NodeCrypto.generateKeyPairSync("ed25519");
  const second = NodeCrypto.generateKeyPairSync("ed25519");
  const signed = createSignedEnvelope(
    { schemaVersion: 1 },
    first.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  const otherPublicKey = second.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  NodeAssert.throws(() => verifySignedEnvelope(signed.envelope, otherPublicKey), /signature/u);
});
