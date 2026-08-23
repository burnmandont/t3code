/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI script has no Effect runtime. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import {
  ARTIFACT_FILE_NAME,
  ARTIFACT_SCHEMA_VERSION,
  MANIFEST_FILE_NAME,
  verifySignedEnvelope,
} from "./artifact-format.mjs";

const baseUrl = process.env.SOVEREIGN_PACKAGE_BASE_URL;
const username = process.env.SOVEREIGN_PACKAGE_USERNAME;
const token = process.env.SOVEREIGN_PACKAGE_TOKEN;
const version = process.env.SOVEREIGN_RUNTIME_VERSION;
const commit = process.env.GITEA_SHA ?? process.env.GITHUB_SHA;
const outputDir = NodePath.resolve(
  process.env.SOVEREIGN_RUNTIME_OUTPUT_DIR ?? "infra/sovereign/dist/runtime",
);
if (!baseUrl || !username || !token || !version || !commit) {
  throw new Error(
    "SOVEREIGN_PACKAGE_BASE_URL, SOVEREIGN_PACKAGE_USERNAME, SOVEREIGN_PACKAGE_TOKEN, SOVEREIGN_RUNTIME_VERSION, and the Git commit are required.",
  );
}
const authorization = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;

function packageUrl(name) {
  return `${baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
}

async function digestFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function digestResponse(response) {
  if (response.body === null) throw new Error("Registry response had no body.");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

function assertExistingPayload(payload) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    payload.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
    payload.version !== version ||
    payload.commit !== commit ||
    payload.platform !== "linux" ||
    payload.arch !== "x64" ||
    payload.fileName !== ARTIFACT_FILE_NAME ||
    typeof payload.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.sha256) ||
    !Number.isSafeInteger(payload.sizeBytes) ||
    payload.sizeBytes <= 0
  ) {
    throw new Error(`Existing signed manifest does not describe expected runtime ${version}.`);
  }
}

async function adoptExistingRuntime() {
  const manifestResponse = await fetch(packageUrl(MANIFEST_FILE_NAME), {
    headers: { Authorization: authorization },
    redirect: "error",
  });
  if (!manifestResponse.ok) {
    throw new Error(
      `Immutable ${version}/${ARTIFACT_FILE_NAME} differs and its manifest returned HTTP ${manifestResponse.status}.`,
    );
  }

  const manifestText = await manifestResponse.text();
  const publicKey = (
    await NodeFSP.readFile(NodePath.join(outputDir, "public-key-spki.b64"), "utf8")
  ).trim();
  let envelope;
  try {
    envelope = JSON.parse(manifestText);
  } catch (error) {
    throw new Error("Existing immutable runtime manifest is not valid JSON.", { cause: error });
  }
  const payload = verifySignedEnvelope(envelope, publicKey);
  assertExistingPayload(payload);

  const artifactResponse = await fetch(packageUrl(ARTIFACT_FILE_NAME), {
    headers: { Authorization: authorization },
    redirect: "error",
  });
  if (!artifactResponse.ok || artifactResponse.body === null) {
    throw new Error(`Reading existing immutable runtime returned HTTP ${artifactResponse.status}.`);
  }

  const artifactPath = NodePath.join(outputDir, ARTIFACT_FILE_NAME);
  const temporaryArtifactPath = `${artifactPath}.existing-${process.pid}`;
  try {
    await NodeStreamPromises.pipeline(
      artifactResponse.body,
      NodeFS.createWriteStream(temporaryArtifactPath, { mode: 0o600 }),
    );
    const file = await NodeFSP.stat(temporaryArtifactPath);
    if (
      file.size !== payload.sizeBytes ||
      (await digestFile(temporaryArtifactPath)) !== payload.sha256
    ) {
      throw new Error("Existing immutable runtime bytes do not match their signed manifest.");
    }
    await NodeFSP.rename(temporaryArtifactPath, artifactPath);
  } finally {
    await NodeFSP.rm(temporaryArtifactPath, { force: true });
  }

  await NodeFSP.writeFile(NodePath.join(outputDir, MANIFEST_FILE_NAME), manifestText);
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "build.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(`Reused signed existing immutable runtime ${version}.\n`);
}

async function upload(path) {
  const name = NodePath.basename(path);
  const url = packageUrl(name);
  const file = await NodeFSP.stat(path);
  const response = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authorization, "Content-Length": String(file.size) },
    body: NodeFS.createReadStream(path),
    duplex: "half",
    redirect: "error",
  });
  if (response.status === 201) {
    process.stdout.write(`Published ${name}.\n`);
    return;
  }
  if (response.status !== 409) {
    throw new Error(
      `Publishing ${name} returned HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const existing = await fetch(url, {
    headers: { Authorization: authorization },
    redirect: "error",
  });
  if (!existing.ok) {
    throw new Error(
      `Reading existing immutable ${version}/${name} returned HTTP ${existing.status}.`,
    );
  }
  if ((await digestResponse(existing)) !== (await digestFile(path))) {
    if (name !== ARTIFACT_FILE_NAME) {
      throw new Error(
        `Registry already contains different bytes for immutable ${version}/${name}.`,
      );
    }
    await adoptExistingRuntime();
    return;
  }
  process.stdout.write(`Verified existing immutable ${name}.\n`);
}

await upload(NodePath.join(outputDir, ARTIFACT_FILE_NAME));
await upload(NodePath.join(outputDir, MANIFEST_FILE_NAME));

const build = JSON.parse(await NodeFSP.readFile(NodePath.join(outputDir, "build.json"), "utf8"));
process.stdout.write(`Published sovereign runtime ${build.version}.\n`);
