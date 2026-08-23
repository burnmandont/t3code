import * as NodeCrypto from "node:crypto";

export const ARTIFACT_SCHEMA_VERSION = 1;
export const ARTIFACT_FILE_NAME = "t3-sovereign-runtime-linux-x64.tar.gz";
export const MANIFEST_FILE_NAME = "linux-x64.manifest.json";

export function sha256(bytes) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`${label} is not canonical base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64.`);
  }
  return decoded;
}

export function deriveSovereignVersion(baseVersion, commit) {
  if (!/^\d+\.\d+\.\d+$/u.test(baseVersion)) {
    throw new Error(`Base runtime version is not stable SemVer: ${baseVersion}`);
  }
  if (!/^[a-f0-9]{7,64}$/u.test(commit)) throw new Error("Commit must be a Git SHA.");
  // The Git identity is build metadata, not a prerelease ordering key. Git
  // hashes are uniformly random, so treating them as SemVer prerelease text
  // makes a newer release sort before an older release roughly half the time.
  // Build metadata preserves the compatible upstream version while retaining
  // an exact, immutable artifact identity.
  return `${baseVersion}+sovereign.g${commit.slice(0, 12)}`;
}

export function createSignedEnvelope(payload, privateKeyPkcs8B64) {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const privateKey = NodeCrypto.createPrivateKey({
    key: decodeCanonicalBase64(privateKeyPkcs8B64, "Signing private key"),
    format: "der",
    type: "pkcs8",
  });
  const signature = NodeCrypto.sign(null, payloadBytes, privateKey);
  return {
    envelope: {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      payload: payloadBytes.toString("base64"),
      signature: signature.toString("base64"),
    },
    publicKeySpkiB64: NodeCrypto.createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

export function verifySignedEnvelope(envelope, publicKeySpkiB64) {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.schemaVersion !== ARTIFACT_SCHEMA_VERSION
  ) {
    throw new Error("Artifact manifest envelope is invalid.");
  }
  const payloadBytes = decodeCanonicalBase64(envelope.payload, "Manifest payload");
  const publicKey = NodeCrypto.createPublicKey({
    key: decodeCanonicalBase64(publicKeySpkiB64, "Signing public key"),
    format: "der",
    type: "spki",
  });
  if (
    !NodeCrypto.verify(
      null,
      payloadBytes,
      publicKey,
      decodeCanonicalBase64(envelope.signature, "Manifest signature"),
    )
  ) {
    throw new Error("Artifact manifest signature is invalid.");
  }
  return JSON.parse(payloadBytes.toString("utf8"));
}
