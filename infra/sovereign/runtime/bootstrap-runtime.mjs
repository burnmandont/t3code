/* oxlint-disable t3code/no-global-process-runtime -- Standalone operator script has no Effect runtime. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import { verifySignedEnvelope } from "./artifact-format.mjs";
import { resolveRuntimePlatform, runtimeArtifactNames } from "./runtime-platform.mjs";

const version = process.argv[2];
const activate = process.argv.includes("--activate");
if (!/^\d+\.\d+\.\d+-sovereign\.g[a-f0-9]{7,64}$/u.test(version ?? "")) {
  throw new Error("Usage: node bootstrap-runtime.mjs <exact-sovereign-version> [--activate]");
}
const target = resolveRuntimePlatform();
const { artifactFileName, manifestFileName } = runtimeArtifactNames(target);

const baseDir = NodePath.resolve(process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3"));
const configPath = NodePath.join(baseDir, "runtime", "artifact-source.json");
const source = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
const sourceUrl = new URL(source.baseUrl);
if (
  source.schemaVersion !== 1 ||
  sourceUrl.protocol !== "https:" ||
  sourceUrl.username.length > 0 ||
  sourceUrl.password.length > 0 ||
  sourceUrl.search.length > 0 ||
  sourceUrl.hash.length > 0 ||
  typeof source.publicKeySpkiB64 !== "string"
) {
  throw new Error("Invalid fail-closed sovereign artifact source configuration.");
}
if ((source.username === undefined) !== (source.token === undefined)) {
  throw new Error("Artifact source credentials are incomplete.");
}
if (
  source.username !== undefined &&
  (typeof source.username !== "string" ||
    source.username.trim().length === 0 ||
    typeof source.token !== "string" ||
    source.token.length === 0)
) {
  throw new Error("Artifact source credentials are invalid.");
}
const headers =
  source.username === undefined
    ? {}
    : {
        Authorization: `Basic ${Buffer.from(`${source.username}:${source.token}`).toString("base64")}`,
      };
const artifactUrl = (name) =>
  `${source.baseUrl.replace(/\/$/u, "")}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;

const manifestResponse = await fetch(artifactUrl(manifestFileName), {
  headers,
  redirect: "error",
  signal: AbortSignal.timeout(60_000),
});
if (!manifestResponse.ok) {
  throw new Error(`Artifact manifest returned HTTP ${manifestResponse.status}.`);
}
const manifestText = await manifestResponse.text();
if (Buffer.byteLength(manifestText) > 128 * 1024)
  throw new Error("Artifact manifest is too large.");
const payload = verifySignedEnvelope(JSON.parse(manifestText), source.publicKeySpkiB64);
if (
  payload.schemaVersion !== 1 ||
  payload.version !== version ||
  payload.platform !== target.platform ||
  payload.arch !== target.arch ||
  payload.fileName !== artifactFileName ||
  !/^[a-f0-9]{64}$/u.test(payload.sha256) ||
  !Number.isSafeInteger(payload.sizeBytes) ||
  payload.sizeBytes <= 0 ||
  payload.sizeBytes > 2 * 1024 * 1024 * 1024
) {
  throw new Error("Signed artifact manifest does not match this installation request.");
}

const versionsDir = NodePath.join(baseDir, "runtime", "versions");
const destination = NodePath.join(versionsDir, version);
const entryPath = NodePath.join(destination, "node_modules", "t3", "dist", "bin.mjs");
const sentinelPath = NodePath.join(destination, ".install-complete");
await NodeFSP.mkdir(versionsDir, { recursive: true });
let installed = false;
try {
  installed = (await NodeFSP.readFile(sentinelPath, "utf8")).trim() === version;
} catch {}

if (!installed) {
  await NodeFSP.rm(destination, { recursive: true, force: true });
  const staging = await NodeFSP.mkdtemp(NodePath.join(versionsDir, ".bootstrap-"));
  try {
    const archivePath = NodePath.join(staging, ".runtime-artifact.tar.gz");
    const response = await fetch(artifactUrl(payload.fileName), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Runtime artifact returned HTTP ${response.status}.`);
    }
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    const meter = new NodeStream.Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > payload.sizeBytes) return callback(new Error("Artifact exceeded signed size."));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body),
      meter,
      NodeFS.createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    );
    if (bytes !== payload.sizeBytes || hash.digest("hex") !== payload.sha256) {
      throw new Error("Artifact bytes do not match the signed manifest.");
    }
    NodeChildProcess.execFileSync(
      "tar",
      ["-xzf", archivePath, "-C", staging, "--no-same-owner", "--no-same-permissions"],
      { stdio: "inherit" },
    );
    await NodeFSP.rm(archivePath, { force: true });
    const stagingEntry = NodePath.join(staging, "node_modules", "t3", "dist", "bin.mjs");
    const reported = NodeChildProcess.execFileSync(process.execPath, [stagingEntry, "--version"], {
      encoding: "utf8",
      env: { ...process.env, T3CODE_HOME: baseDir },
    });
    if (!reported.trim().endsWith(`v${version}`))
      throw new Error("Runtime reported wrong version.");

    const bundledFrpc = NodePath.join(staging, "tools", "frpc", "0.70.1", target.key, "frpc");
    if ((await NodeFSP.stat(bundledFrpc)).isFile()) {
      await NodeFSP.chmod(bundledFrpc, 0o755);
      const frpcVersion = NodeChildProcess.execFileSync(bundledFrpc, ["--version"], {
        encoding: "utf8",
      });
      if (!frpcVersion.includes("0.70.1")) throw new Error("Bundled FRP client is invalid.");
      const managedFrpc = NodePath.join(baseDir, "tools", "frpc", "0.70.1", target.key, "frpc");
      await NodeFSP.mkdir(NodePath.dirname(managedFrpc), { recursive: true });
      const stagedFrpc = `${managedFrpc}.${process.pid}.tmp`;
      await NodeFSP.copyFile(bundledFrpc, stagedFrpc);
      await NodeFSP.chmod(stagedFrpc, 0o755);
      await NodeFSP.rename(stagedFrpc, managedFrpc);
    }
    await NodeFSP.writeFile(
      NodePath.join(staging, ".runtime-artifact.json"),
      `${JSON.stringify(payload)}\n`,
      { mode: 0o600 },
    );
    await NodeFSP.writeFile(NodePath.join(staging, ".install-complete"), `${version}\n`, {
      mode: 0o600,
    });
    await NodeFSP.rename(staging, destination);
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

process.stdout.write(`Verified sovereign runtime ${version} at ${destination}.\n`);
if (activate) {
  NodeChildProcess.execFileSync(process.execPath, [entryPath, "service", "update"], {
    stdio: "inherit",
    env: { ...process.env, T3CODE_HOME: baseDir },
  });
}
