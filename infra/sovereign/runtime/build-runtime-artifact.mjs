/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI script has no Effect runtime. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ARTIFACT_SCHEMA_VERSION, createSignedEnvelope } from "./artifact-format.mjs";
import { resolveRuntimePlatform, runtimeArtifactNames } from "./runtime-platform.mjs";

const FRPC_VERSION = "0.70.1";
const target = resolveRuntimePlatform();
const { artifactFileName: ARTIFACT_FILE_NAME, manifestFileName: MANIFEST_FILE_NAME } =
  runtimeArtifactNames(target);
const repoRoot = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "../../..");
const version = process.env.SOVEREIGN_RUNTIME_VERSION;
const commit = process.env.GITEA_SHA ?? process.env.GITHUB_SHA;
const privateKey = process.env.SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64;
const frpcAssetUrl = process.env.SOVEREIGN_FRPC_ASSET_URL;
const packageUsername = process.env.SOVEREIGN_PACKAGE_USERNAME;
const packageToken = process.env.SOVEREIGN_PACKAGE_TOKEN;
const unsignedBuild = process.env.SOVEREIGN_RUNTIME_UNSIGNED_BUILD === "1";
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

if (
  !version ||
  !commit ||
  !frpcAssetUrl ||
  (!unsignedBuild && (!privateKey || !packageUsername || !packageToken))
) {
  throw new Error(
    "Runtime version, Git SHA, FRP URL, and signing/package credentials are required for a signed build.",
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
  const nodePtyPackageRoot = NodePath.join(repoRoot, "apps/server/node_modules/node-pty");
  const nodePtySource = NodePath.join(nodePtyPackageRoot, "build", "Release");
  const nodeGyp = NodePath.join(repoRoot, "apps/server/node_modules/.bin/node-gyp");
  await NodeFSP.mkdir(NodePath.dirname(t3Root), { recursive: true });

  // pnpm's rebuild bookkeeping does not mark dependencies from the runner's
  // script-free install as pending. Build this one audited native dependency
  // directly with the node-gyp version already pinned in the workspace lock.
  NodeChildProcess.execFileSync(nodeGyp, ["rebuild"], {
    cwd: nodePtyPackageRoot,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  NodeChildProcess.execFileSync(
    "pnpm",
    ["--filter", "t3", "deploy", "--prod", "--legacy", "--ignore-scripts", deployed],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    },
  );

  // Keep deployment script-free: pnpm's legacy deploy can otherwise start
  // msgpackr-extract before its nested helper binary is linked. Copy only the
  // validated node-pty release output into the isolated closure and prove both
  // native modules load from that closure before it is signed.
  const nodePtyRoot = NodePath.join(deployed, "node_modules/node-pty");
  const nodePtyRelease = NodePath.join(nodePtyRoot, "build", "Release");
  try {
    await NodeFSP.access(NodePath.join(nodePtySource, "pty.node"));
  } catch {
    throw new Error("The validated node-pty build output is missing from the workspace.");
  }
  await NodeFSP.mkdir(NodePath.dirname(nodePtyRelease), { recursive: true });
  await NodeFSP.cp(nodePtySource, nodePtyRelease, { recursive: true, force: true });
  for (const helper of [
    NodePath.join(nodePtyRelease, "spawn-helper"),
    NodePath.join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ]) {
    try {
      await NodeFSP.chmod(helper, 0o755);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      "-e",
      `const pty = require("node-pty");
const child = pty.spawn("/bin/sh", ["-c", "printf sovereign-runtime-pty-ok"], { cols: 80, rows: 24 });
let output = "";
const timeout = setTimeout(() => { console.error("node-pty smoke test timed out"); process.exit(1); }, 5_000);
child.onData((data) => { output += data; });
child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (exitCode !== 0 || !output.includes("sovereign-runtime-pty-ok")) process.exit(1);
});`,
    ],
    { cwd: deployed, stdio: "inherit" },
  );
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      "-e",
      `const extract = require("msgpackr-extract");
if (typeof extract.extractStrings !== "function") process.exit(1);`,
    ],
    { cwd: deployed, stdio: "inherit" },
  );
  await NodeFSP.rename(deployed, t3Root);

  const frpcArchive = NodePath.join(workspace, "frpc.tar.gz");
  const frpcAuthorization =
    packageUsername && packageToken
      ? `Basic ${Buffer.from(`${packageUsername}:${packageToken}`).toString("base64")}`
      : undefined;
  const response = await fetch(frpcAssetUrl, {
    headers: frpcAuthorization ? { Authorization: frpcAuthorization } : undefined,
    // Never forward registry credentials through a redirect. Public GitHub
    // release assets legitimately redirect to credentialless object storage.
    redirect: frpcAuthorization ? "error" : "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`FRP release download returned HTTP ${response.status}.`);
  if (new URL(response.url).protocol !== "https:") {
    throw new Error("FRP release download redirected away from HTTPS.");
  }
  const frpcBytes = Buffer.from(await response.arrayBuffer());
  if (NodeCrypto.createHash("sha256").update(frpcBytes).digest("hex") !== target.frpcSha256) {
    throw new Error("FRP release checksum mismatch.");
  }
  await NodeFSP.writeFile(frpcArchive, frpcBytes, { mode: 0o600 });
  const frpcExtract = NodePath.join(workspace, "frpc-extract");
  await NodeFSP.mkdir(frpcExtract);
  NodeChildProcess.execFileSync("tar", ["-xzf", frpcArchive, "-C", frpcExtract], {
    stdio: "inherit",
  });
  const frpcDestination = NodePath.join(root, "tools", "frpc", FRPC_VERSION, target.key, "frpc");
  await NodeFSP.mkdir(NodePath.dirname(frpcDestination), { recursive: true });
  await NodeFSP.copyFile(
    NodePath.join(frpcExtract, target.frpcArchiveDirectory, "frpc"),
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
  const tarArguments =
    process.platform === "linux"
      ? [
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
        ]
      : ["-cf", tarPath, "-C", root, "."];
  NodeChildProcess.execFileSync("tar", tarArguments, { stdio: "inherit" });
  NodeChildProcess.execFileSync("gzip", ["-n", "-9", tarPath], { stdio: "inherit" });
  // The runner commonly mounts /tmp and the checkout on different filesystems,
  // where rename(2) fails with EXDEV. This is an ephemeral, freshly emptied
  // output directory; immutable publication and byte comparison happen in the
  // following Gitea step.
  await NodeFSP.copyFile(`${tarPath}.gz`, archivePath);

  const payload = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    version,
    platform: target.platform,
    arch: target.arch,
    fileName: NodePath.basename(archivePath),
    sha256: await digestFile(archivePath),
    sizeBytes: (await NodeFSP.stat(archivePath)).size,
    commit,
  };
  if (!unsignedBuild) {
    const signed = createSignedEnvelope(payload, privateKey);
    await NodeFSP.writeFile(
      NodePath.join(outputDir, MANIFEST_FILE_NAME),
      `${JSON.stringify(signed.envelope)}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(outputDir, "public-key-spki.b64"),
      `${signed.publicKeySpkiB64}\n`,
    );
  }
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "build.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(`Built ${version} (${payload.sha256}, ${payload.sizeBytes} bytes).\n`);
} finally {
  await NodeFSP.rm(workspace, { recursive: true, force: true });
}
