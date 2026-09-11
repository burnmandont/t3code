/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI signing step. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { createSignedEnvelope } from "./artifact-format.mjs";
import { resolveRuntimePlatform, runtimeArtifactNames } from "./runtime-platform.mjs";

const outputDir = NodePath.resolve(
  process.env.SOVEREIGN_RUNTIME_OUTPUT_DIR ?? "infra/sovereign/dist/runtime",
);
const privateKey = process.env.SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64;
const expectedVersion = process.env.SOVEREIGN_RUNTIME_VERSION;
const expectedCommit = process.env.GITEA_SHA ?? process.env.GITHUB_SHA;
if (!privateKey || !expectedVersion || !expectedCommit) {
  throw new Error("Runtime signing key, version, and Git commit are required.");
}

const payload = JSON.parse(await NodeFSP.readFile(NodePath.join(outputDir, "build.json"), "utf8"));
const target = resolveRuntimePlatform(payload.platform, payload.arch);
const { artifactFileName, manifestFileName } = runtimeArtifactNames(target);
const artifactPath = NodePath.join(outputDir, artifactFileName);
const hash = NodeCrypto.createHash("sha256");
for await (const chunk of NodeFS.createReadStream(artifactPath)) hash.update(chunk);
const sizeBytes = (await NodeFSP.stat(artifactPath)).size;
if (
  payload.version !== expectedVersion ||
  payload.commit !== expectedCommit ||
  payload.fileName !== artifactFileName ||
  payload.sha256 !== hash.digest("hex") ||
  payload.sizeBytes !== sizeBytes
) {
  throw new Error("Unsigned runtime artifact does not match its build metadata.");
}
const signed = createSignedEnvelope(payload, privateKey);
await NodeFSP.writeFile(
  NodePath.join(outputDir, manifestFileName),
  `${JSON.stringify(signed.envelope)}\n`,
);
await NodeFSP.writeFile(
  NodePath.join(outputDir, "public-key-spki.b64"),
  `${signed.publicKeySpkiB64}\n`,
);
process.stdout.write(`Signed ${target.key} runtime ${payload.version}.\n`);
