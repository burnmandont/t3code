/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI script has no Effect runtime. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ARTIFACT_FILE_NAME,
  ARTIFACT_SCHEMA_VERSION,
  createSignedEnvelope,
  MANIFEST_FILE_NAME,
} from "./artifact-format.mjs";

const FRPC_VERSION = "0.70.1";
const FRPC_SHA256 = "333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6";
const repoRoot = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "../../..");
const version = process.env.SOVEREIGN_RUNTIME_VERSION;
const commit = process.env.GITEA_SHA ?? process.env.GITHUB_SHA;
const privateKey = process.env.SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64;
const frpcAssetUrl = process.env.SOVEREIGN_FRPC_ASSET_URL;
const packageUsername = process.env.SOVEREIGN_PACKAGE_USERNAME;
const packageToken = process.env.SOVEREIGN_PACKAGE_TOKEN;
const outputDir = NodePath.resolve(
  repoRoot,
  process.env.SOVEREIGN_RUNTIME_OUTPUT_DIR ?? "infra/sovereign/dist/runtime",
);
const PRIVATE_CONTROL_PLANE_VALUES = [
  "https://code.moondiner.com",
  "https://auth.moondiner.com/api/auth",
  "https://relay.moondiner.com",
];

async function digestFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertValuesAbsent(root, values, description) {
  const needles = values
    .filter((value) => typeof value === "string" && value.length >= 16)
    .map((value) => Buffer.from(value));
  const overlap = Math.max(...needles.map((needle) => needle.length), 1) - 1;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let carry = Buffer.alloc(0);
      for await (const chunk of NodeFS.createReadStream(path)) {
        const window = Buffer.concat([carry, chunk]);
        if (needles.some((needle) => window.includes(needle))) {
          throw new Error(`Runtime artifact would contain ${description} in ${path}.`);
        }
        carry = overlap === 0 ? Buffer.alloc(0) : window.subarray(-overlap);
      }
    }
  }
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The initial sovereign runtime builder requires a Linux x64 runner.");
}
if (!version || !commit || !privateKey || !frpcAssetUrl || !packageUsername || !packageToken) {
  throw new Error(
    "Runtime version, Git SHA, signing key, mirrored FRP URL, and Gitea package credentials are required.",
  );
}
if (new URL(frpcAssetUrl).protocol !== "https:") {
  throw new Error("The mirrored FRP asset URL must use HTTPS.");
}

const packageJson = JSON.parse(
  await NodeFSP.readFile(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
);
if (packageJson.version !== version)
  throw new Error("Built package version does not match runtime version.");

const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sovereign-runtime-"));
try {
  const deployed = NodePath.join(workspace, "deployed");
  const root = NodePath.join(workspace, "root");
  const t3Root = NodePath.join(root, "node_modules", "t3");
  await NodeFSP.mkdir(NodePath.dirname(t3Root), { recursive: true });
  NodeChildProcess.execFileSync(
    "pnpm",
    ["--filter", "t3", "deploy", "--prod", "--legacy", deployed],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    },
  );
  await NodeFSP.rename(deployed, t3Root);

  const frpcArchive = NodePath.join(workspace, "frpc.tar.gz");
  const response = await fetch(frpcAssetUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${packageUsername}:${packageToken}`).toString("base64")}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`FRP release download returned HTTP ${response.status}.`);
  const frpcBytes = Buffer.from(await response.arrayBuffer());
  if (NodeCrypto.createHash("sha256").update(frpcBytes).digest("hex") !== FRPC_SHA256) {
    throw new Error("FRP release checksum mismatch.");
  }
  await NodeFSP.writeFile(frpcArchive, frpcBytes, { mode: 0o600 });
  const frpcExtract = NodePath.join(workspace, "frpc-extract");
  await NodeFSP.mkdir(frpcExtract);
  NodeChildProcess.execFileSync("tar", ["-xzf", frpcArchive, "-C", frpcExtract], {
    stdio: "inherit",
  });
  const frpcDestination = NodePath.join(root, "tools", "frpc", FRPC_VERSION, "linux-x64", "frpc");
  await NodeFSP.mkdir(NodePath.dirname(frpcDestination), { recursive: true });
  await NodeFSP.copyFile(
    NodePath.join(frpcExtract, "frp_0.70.1_linux_amd64", "frpc"),
    frpcDestination,
  );
  await NodeFSP.chmod(frpcDestination, 0o755);

  // The archive is published anonymously. Prove that neither the operator's
  // private endpoints nor either credential reached the production closure.
  await assertValuesAbsent(root, PRIVATE_CONTROL_PLANE_VALUES, "a private control-plane endpoint");
  await assertValuesAbsent(root, [privateKey, packageToken], "a CI credential");

  await NodeFSP.rm(outputDir, { recursive: true, force: true });
  await NodeFSP.mkdir(outputDir, { recursive: true });
  const tarPath = NodePath.join(workspace, "runtime.tar");
  const archivePath = NodePath.join(outputDir, ARTIFACT_FILE_NAME);
  NodeChildProcess.execFileSync(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      tarPath,
      "-C",
      root,
      ".",
    ],
    { stdio: "inherit" },
  );
  NodeChildProcess.execFileSync("gzip", ["-n", "-9", tarPath], { stdio: "inherit" });
  // The runner commonly mounts /tmp and the checkout on different filesystems,
  // where rename(2) fails with EXDEV. This is an ephemeral, freshly emptied
  // output directory; immutable publication and byte comparison happen in the
  // following Gitea step.
  await NodeFSP.copyFile(`${tarPath}.gz`, archivePath);

  const payload = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    version,
    platform: "linux",
    arch: "x64",
    fileName: NodePath.basename(archivePath),
    sha256: await digestFile(archivePath),
    sizeBytes: (await NodeFSP.stat(archivePath)).size,
    commit,
  };
  const signed = createSignedEnvelope(payload, privateKey);
  await NodeFSP.writeFile(
    NodePath.join(outputDir, MANIFEST_FILE_NAME),
    `${JSON.stringify(signed.envelope)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "public-key-spki.b64"),
    `${signed.publicKeySpkiB64}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "build.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(`Built ${version} (${payload.sha256}, ${payload.sizeBytes} bytes).\n`);
} finally {
  await NodeFSP.rm(workspace, { recursive: true, force: true });
}
