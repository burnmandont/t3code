import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  ARTIFACT_FILE_NAME,
  createSignedEnvelope,
  MANIFEST_FILE_NAME,
  sha256,
} from "./artifact-format.mjs";

const scriptPath = NodePath.join(
  NodePath.dirname(new URL(import.meta.url).pathname),
  "publish-runtime-artifact.mjs",
);

async function runScript(environment) {
  const child = NodeChildProcess.spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

NodeTest.test(
  "reuses a signed existing immutable runtime when a rerun rebuild differs",
  async () => {
    const temporaryDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "publish-runtime-artifact-test-"),
    );
    const version = "0.0.32+sovereign.g5ed5b5740ef9";
    const commit = "5ed5b5740ef9123456789abcdef";
    const existingArtifact = Buffer.from("first successfully published runtime");
    const rebuiltArtifact = Buffer.from("different bytes from the same source commit");
    const { privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
    const signingKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const payload = {
      schemaVersion: 1,
      version,
      platform: "linux",
      arch: "x64",
      fileName: ARTIFACT_FILE_NAME,
      sha256: sha256(existingArtifact),
      sizeBytes: existingArtifact.length,
      commit,
    };
    const signed = createSignedEnvelope(payload, signingKey);
    const existingManifest = Buffer.from(`${JSON.stringify(signed.envelope)}\n`);

    await NodeFSP.writeFile(NodePath.join(temporaryDirectory, ARTIFACT_FILE_NAME), rebuiltArtifact);
    await NodeFSP.writeFile(
      NodePath.join(temporaryDirectory, MANIFEST_FILE_NAME),
      `${JSON.stringify(
        createSignedEnvelope(
          { ...payload, sha256: sha256(rebuiltArtifact), sizeBytes: rebuiltArtifact.length },
          signingKey,
        ).envelope,
      )}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(temporaryDirectory, "public-key-spki.b64"),
      `${signed.publicKeySpkiB64}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(temporaryDirectory, "build.json"),
      `${JSON.stringify({ ...payload, sha256: sha256(rebuiltArtifact) })}\n`,
    );

    const server = NodeHttp.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain PUT bodies before responding so the client can reuse the connection safely.
      }
      if (request.method === "PUT") {
        response.writeHead(409).end();
        return;
      }
      if (request.url?.endsWith(`/${ARTIFACT_FILE_NAME}`)) {
        response.writeHead(200, { "Content-Length": existingArtifact.length });
        response.end(existingArtifact);
        return;
      }
      if (request.url?.endsWith(`/${MANIFEST_FILE_NAME}`)) {
        response.writeHead(200, { "Content-Length": existingManifest.length });
        response.end(existingManifest);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    NodeAssert.notEqual(address, null);
    NodeAssert.equal(typeof address, "object");

    try {
      const result = await runScript({
        GITEA_SHA: commit,
        SOVEREIGN_PACKAGE_BASE_URL: `http://127.0.0.1:${address.port}/packages`,
        SOVEREIGN_PACKAGE_TOKEN: "test-token",
        SOVEREIGN_PACKAGE_USERNAME: "test-user",
        SOVEREIGN_RUNTIME_OUTPUT_DIR: temporaryDirectory,
        SOVEREIGN_RUNTIME_VERSION: version,
      });
      NodeAssert.equal(result.code, 0, result.stderr);
      NodeAssert.match(result.stdout, /Reused signed existing immutable runtime/u);
      NodeAssert.deepEqual(
        await NodeFSP.readFile(NodePath.join(temporaryDirectory, ARTIFACT_FILE_NAME)),
        existingArtifact,
      );
      NodeAssert.deepEqual(
        JSON.parse(await NodeFSP.readFile(NodePath.join(temporaryDirectory, "build.json"), "utf8")),
        payload,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
);
