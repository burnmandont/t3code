/* oxlint-disable t3code/no-global-process-runtime -- Published standalone installer. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

const CHANNEL_URL = "__SOVEREIGN_CHANNEL_URL__";
const RELEASE_BASE_URL = "__SOVEREIGN_RELEASE_BASE_URL__";
const PUBLIC_KEY_SPKI_B64 = "__SOVEREIGN_PUBLIC_KEY_SPKI_B64__";
const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const CONTROL_PLANE_DISCOVERY_PATH = "/.well-known/t3-sovereign.json";

function resolveRuntimeTarget() {
  const key = `${process.platform}-${process.arch}`;
  if (key !== "linux-x64" && key !== "darwin-arm64") {
    throw new Error(`Sovereign installer does not support ${key}.`);
  }
  return {
    key,
    artifactFileName: `t3-sovereign-runtime-${key}.tar.gz`,
    manifestFileName: `${key}.manifest.json`,
  };
}

function normalizeOrigin(value, label) {
  const url = new URL(value.trim());
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} must be a credential-free HTTPS origin.`);
  }
  return url.origin;
}

function normalizePublicUrl(value, label) {
  const url = new URL(value.trim());
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL.`);
  }
  return url.toString().replace(/\/$/u, "");
}

function validateControlPlaneDocument(value, expectedOrigin) {
  if (typeof value !== "object" || value === null || value.schemaVersion !== 1) {
    throw new Error("Control-plane discovery document is invalid or unsupported.");
  }
  const origin = normalizeOrigin(value.origin ?? value.hostedAppUrl, "Control-plane origin");
  const hostedAppUrl = normalizeOrigin(value.hostedAppUrl, "Hosted app URL");
  if (origin !== expectedOrigin || hostedAppUrl !== expectedOrigin) {
    throw new Error("Control-plane discovery document does not describe the requested origin.");
  }
  const oauthClientId = typeof value.oauthClientId === "string" ? value.oauthClientId.trim() : "";
  if (!oauthClientId || oauthClientId.length > 256) throw new Error("OAuth client ID is invalid.");
  return {
    schemaVersion: 1,
    origin,
    hostedAppUrl,
    oauthIssuer: normalizePublicUrl(value.oauthIssuer, "OAuth issuer"),
    oauthClientId,
    oauthResource: normalizePublicUrl(value.oauthResource, "OAuth resource"),
    relayUrl: normalizeOrigin(value.relayUrl, "Relay URL"),
  };
}

function controlPlaneEnvironment(profile) {
  return {
    T3CODE_HOSTED_APP_URL: profile.hostedAppUrl,
    T3CODE_OAUTH_ISSUER: profile.oauthIssuer,
    T3CODE_OAUTH_CLIENT_ID: profile.oauthClientId,
    T3CODE_OAUTH_RESOURCE: profile.oauthResource,
    T3CODE_RELAY_URL: profile.relayUrl,
  };
}

function normalizeEnvironmentLabel(value) {
  const label = value.trim().replace(/\s+/gu, " ");
  if (!label || label.length > 100 || /\p{Cc}/u.test(label)) {
    throw new Error("Environment label must be 1-100 printable characters.");
  }
  return label;
}

export async function promptQuestions(
  questions,
  { input = process.stdin, output = process.stdout } = {},
) {
  let cancelled = false;
  const controller = new AbortController();
  const NodeReadlinePromises = await import("node:readline/promises");
  const prompt = NodeReadlinePromises.createInterface({ input, output });
  prompt.once("SIGINT", () => {
    cancelled = true;
    controller.abort();
  });
  try {
    const answers = [];
    for (const question of questions) {
      answers.push(await prompt.question(question, { signal: controller.signal }));
    }
    return answers;
  } catch (cause) {
    if (cancelled) {
      const cancellation = new Error("Installation cancelled.", { cause });
      cancellation.status = 130;
      throw cancellation;
    }
    throw new Error("Could not read installer input from the controlling terminal.", { cause });
  } finally {
    prompt.close();
  }
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function configureRuntimeSettings(baseDir, command) {
  const runtimeDir = NodePath.join(baseDir, "runtime");
  const profilePath = NodePath.join(runtimeDir, "control-plane.json");
  const labelPath = NodePath.join(runtimeDir, "environment-label");
  await NodeFSP.mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  let profile = await readJsonIfPresent(profilePath);
  let label;
  try {
    label = normalizeEnvironmentLabel(await NodeFSP.readFile(labelPath, "utf8"));
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  const configuredOrigin = process.env.T3CODE_CONTROL_PLANE_URL?.trim() || "";
  const configuredLabel = process.env.T3CODE_ENVIRONMENT_LABEL?.trim() || "";
  const questions = [];
  if (command[0] === "serve" && profile === undefined) {
    questions.push(
      configuredOrigin
        ? `Sovereign control-plane URL [${configuredOrigin}]: `
        : "Sovereign control-plane URL: ",
    );
  }
  if (command[0] === "serve" && label === undefined) {
    questions.push(
      configuredLabel
        ? `Environment display label [${configuredLabel}]: `
        : "Environment display label: ",
    );
  }
  const answers = questions.length > 0 ? await promptQuestions(questions) : [];
  let answerIndex = 0;
  const controlPlaneAnswer =
    command[0] === "serve" && profile === undefined ? (answers[answerIndex++] ?? "") : "";
  const labelAnswer =
    command[0] === "serve" && label === undefined ? (answers[answerIndex++] ?? "") : "";

  if (profile === undefined) {
    const requestedOrigin = controlPlaneAnswer.trim() || configuredOrigin;
    if (!requestedOrigin && command[0] === "serve") {
      throw new Error("A sovereign control-plane URL is required.");
    }
    if (requestedOrigin) {
      const origin = normalizeOrigin(requestedOrigin, "Control-plane URL");
      profile = validateControlPlaneDocument(await fetchControlPlaneDocument(origin), origin);
      await writePrivateFileAtomically(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    }
  } else {
    profile = validateControlPlaneDocument(
      profile,
      normalizeOrigin(profile.origin, "Control-plane origin"),
    );
  }

  if (label === undefined) {
    const requestedLabel = labelAnswer.trim() || configuredLabel;
    if (!requestedLabel && command[0] === "serve") {
      throw new Error("An environment display label is required.");
    }
    if (requestedLabel) {
      label = normalizeEnvironmentLabel(requestedLabel);
      await writePrivateFileAtomically(labelPath, `${label}\n`);
    }
  }

  if (profile !== undefined) process.stdout.write(`Control plane: ${profile.origin}\n`);
  if (label !== undefined) process.stdout.write(`Environment label: ${label}\n`);
  return profile === undefined ? {} : controlPlaneEnvironment(profile);
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

function verifySignedEnvelope(text, label) {
  const envelope = JSON.parse(text);
  if (typeof envelope !== "object" || envelope === null || envelope.schemaVersion !== 1) {
    throw new Error(`${label} envelope is invalid.`);
  }
  const payload = decodeCanonicalBase64(envelope.payload, `${label} payload`);
  const signature = decodeCanonicalBase64(envelope.signature, `${label} signature`);
  const publicKey = NodeCrypto.createPublicKey({
    key: decodeCanonicalBase64(PUBLIC_KEY_SPKI_B64, "Runtime signing public key"),
    format: "der",
    type: "spki",
  });
  if (!NodeCrypto.verify(null, payload, publicKey, signature)) {
    throw new Error(`${label} signature is invalid.`);
  }
  return JSON.parse(payload.toString("utf8"));
}

async function fetchSmallDocument(url, label) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  if (new URL(response.url).protocol !== "https:") {
    throw new Error(`${label} redirected away from HTTPS.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_DOCUMENT_BYTES) throw new Error(`${label} is too large.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`${label} is too large.`);
  return bytes.toString("utf8");
}

async function fetchControlPlaneDocument(origin) {
  let response;
  try {
    response = await fetch(new URL(CONTROL_PLANE_DISCOVERY_PATH, origin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    const unavailable = new Error("Control-plane discovery is unreachable.", { cause });
    unavailable.code = "DISCOVERY_UNAVAILABLE";
    throw unavailable;
  }
  if (
    response.status === 404 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    const unavailable = new Error("Control-plane discovery is not published.");
    unavailable.code = "DISCOVERY_UNAVAILABLE";
    throw unavailable;
  }
  if (!response.ok) {
    throw new Error(`Control-plane discovery returned HTTP ${response.status}.`);
  }
  if (response.body === null) throw new Error("Control-plane discovery response has no body.");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_DOCUMENT_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Control-plane discovery document is too large.");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

async function writePrivateFileAtomically(filePath, contents) {
  const directory = NodePath.dirname(filePath);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  try {
    await NodeFSP.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validateRuntimeVersion(version) {
  if (!/^\d+\.\d+\.\d+\+sovereign\.g[a-f0-9]{7,64}$/u.test(version ?? "")) {
    throw new Error("The requested sovereign runtime version is invalid.");
  }
  return version;
}

function parseArguments(args) {
  const command = [...args];
  const versionIndex = command.indexOf("--version");
  if (versionIndex === -1) return { command, requestedVersion: undefined };
  const requestedVersion = validateRuntimeVersion(command[versionIndex + 1]);
  command.splice(versionIndex, 2);
  return { command, requestedVersion };
}

async function resolveVersion(requestedVersion) {
  if (requestedVersion !== undefined) return requestedVersion;
  const payload = verifySignedEnvelope(
    await fetchSmallDocument(CHANNEL_URL, "Stable channel"),
    "Stable channel",
  );
  if (
    payload.schemaVersion !== 1 ||
    payload.channel !== "stable" ||
    !/^[a-f0-9]{7,64}$/u.test(payload.commit ?? "")
  ) {
    throw new Error("The verified stable channel is invalid.");
  }
  const version = validateRuntimeVersion(payload.version);
  if (!version.endsWith(`g${payload.commit.slice(0, 12)}`)) {
    throw new Error("The stable channel version does not match its commit.");
  }
  return version;
}

function releaseAssetUrl(version, fileName) {
  const base = RELEASE_BASE_URL.endsWith("/") ? RELEASE_BASE_URL : `${RELEASE_BASE_URL}/`;
  return new URL(`runtime-${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`, base);
}

async function downloadArtifact(url, destination, payload) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Runtime archive returned HTTP ${response.status}.`);
  }
  if (new URL(response.url).protocol !== "https:") {
    throw new Error("Runtime archive redirected away from HTTPS.");
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 0 && contentLength !== payload.sizeBytes) {
    throw new Error("Runtime archive length does not match its signed manifest.");
  }
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  const meter = new NodeStream.Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > payload.sizeBytes || bytes > MAX_ARTIFACT_BYTES) {
        callback(new Error("Runtime archive exceeded its signed size."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    meter,
    NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== payload.sizeBytes || hash.digest("hex") !== payload.sha256) {
    throw new Error("Runtime archive bytes do not match the signed manifest.");
  }
}

function validateManifest(payload, version, target) {
  if (
    payload.schemaVersion !== 1 ||
    payload.version !== version ||
    payload.platform !== process.platform ||
    payload.arch !== process.arch ||
    payload.fileName !== target.artifactFileName ||
    !/^[a-f0-9]{64}$/u.test(payload.sha256 ?? "") ||
    !Number.isSafeInteger(payload.sizeBytes) ||
    payload.sizeBytes <= 0 ||
    payload.sizeBytes > MAX_ARTIFACT_BYTES ||
    !/^[a-f0-9]{7,64}$/u.test(payload.commit ?? "")
  ) {
    throw new Error("The verified runtime manifest is invalid.");
  }
}

async function installRuntime(baseDir, version, runtimeEnv) {
  const target = resolveRuntimeTarget();
  const versionsDir = NodePath.join(baseDir, "runtime", "versions");
  const destination = NodePath.join(versionsDir, version);
  const entryPath = NodePath.join(destination, "node_modules", "t3", "dist", "bin.mjs");
  const sentinelPath = NodePath.join(destination, ".install-complete");
  const provenancePath = NodePath.join(destination, ".runtime-artifact.json");
  try {
    const sentinel = (await NodeFSP.readFile(sentinelPath, "utf8")).trim();
    const provenance = JSON.parse(await NodeFSP.readFile(provenancePath, "utf8"));
    if (sentinel === version && provenance.version === version) return entryPath;
  } catch {}

  await NodeFSP.mkdir(versionsDir, { recursive: true });
  await NodeFSP.rm(destination, { recursive: true, force: true });
  const staging = await NodeFSP.mkdtemp(NodePath.join(versionsDir, ".bootstrap-"));
  try {
    const manifest = verifySignedEnvelope(
      await fetchSmallDocument(
        releaseAssetUrl(version, target.manifestFileName),
        "Runtime manifest",
      ),
      "Runtime manifest",
    );
    validateManifest(manifest, version, target);
    const archivePath = NodePath.join(staging, ".runtime-artifact.tar.gz");
    await downloadArtifact(releaseAssetUrl(version, manifest.fileName), archivePath, manifest);
    NodeChildProcess.execFileSync(
      "tar",
      ["-xzf", archivePath, "-C", staging, "--no-same-owner", "--no-same-permissions"],
      { stdio: "inherit" },
    );
    await NodeFSP.rm(archivePath, { force: true });
    const stagingEntry = NodePath.join(staging, "node_modules", "t3", "dist", "bin.mjs");
    const reported = NodeChildProcess.execFileSync(process.execPath, [stagingEntry, "--version"], {
      encoding: "utf8",
      env: { ...process.env, ...runtimeEnv, T3CODE_HOME: baseDir },
    });
    if (!reported.trim().endsWith(`v${version}`)) {
      throw new Error("The installed runtime reported the wrong version.");
    }
    const bundledFrpc = NodePath.join(staging, "tools", "frpc", "0.70.1", target.key, "frpc");
    const frpcVersion = NodeChildProcess.execFileSync(bundledFrpc, ["--version"], {
      encoding: "utf8",
    });
    if (!frpcVersion.includes("0.70.1")) {
      throw new Error("The bundled FRP client reported the wrong version.");
    }
    const managedFrpc = NodePath.join(baseDir, "tools", "frpc", "0.70.1", target.key, "frpc");
    await NodeFSP.mkdir(NodePath.dirname(managedFrpc), { recursive: true });
    const stagedFrpc = `${managedFrpc}.${process.pid}.tmp`;
    await NodeFSP.copyFile(bundledFrpc, stagedFrpc);
    await NodeFSP.chmod(stagedFrpc, 0o755);
    await NodeFSP.rename(stagedFrpc, managedFrpc);
    await NodeFSP.writeFile(
      NodePath.join(staging, ".runtime-artifact.json"),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 },
    );
    await NodeFSP.writeFile(NodePath.join(staging, ".install-complete"), `${version}\n`, {
      mode: 0o600,
    });
    await NodeFSP.rename(staging, destination);
    return entryPath;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderCliWrapper(baseDir, nodePath) {
  return `#!/bin/sh\nexport T3CODE_HOME=${shellSingleQuote(baseDir)}\nexec ${shellSingleQuote(nodePath)} "$T3CODE_HOME/runtime/cli-launcher.mjs" "$@"\n`;
}

async function configureInstallation(baseDir, version) {
  const runtimeDir = NodePath.join(baseDir, "runtime");
  await NodeFSP.mkdir(runtimeDir, { recursive: true });
  const source = {
    schemaVersion: 2,
    releaseBaseUrl: RELEASE_BASE_URL.replace(/\/$/u, ""),
    publicKeySpkiB64: PUBLIC_KEY_SPKI_B64,
  };
  await NodeFSP.writeFile(
    NodePath.join(runtimeDir, "artifact-source.json"),
    `${JSON.stringify(source, null, 2)}\n`,
    { mode: 0o600 },
  );
  await NodeFSP.writeFile(NodePath.join(runtimeDir, "current-version"), `${version}\n`, {
    mode: 0o600,
  });

  const cliLauncher = `import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
const baseDir = process.env.T3CODE_HOME || ${JSON.stringify(baseDir)};
function controlPlaneEnv() {
  try {
    const profile = JSON.parse(FS.readFileSync(Path.join(baseDir, "runtime", "control-plane.json"), "utf8"));
    return {
      T3CODE_HOSTED_APP_URL: profile.hostedAppUrl,
      T3CODE_OAUTH_ISSUER: profile.oauthIssuer,
      T3CODE_OAUTH_CLIENT_ID: profile.oauthClientId,
      T3CODE_OAUTH_RESOURCE: profile.oauthResource,
      T3CODE_RELAY_URL: profile.relayUrl,
    };
  } catch { return {}; }
}
let version = FS.readFileSync(Path.join(baseDir, "runtime", "current-version"), "utf8").trim();
try {
  const state = JSON.parse(FS.readFileSync(Path.join(baseDir, "runtime", "service-state.json"), "utf8"));
  if (typeof state.activeVersion === "string") version = state.activeVersion;
} catch {}
const entry = Path.join(baseDir, "runtime", "versions", version, "node_modules", "t3", "dist", "bin.mjs");
const child = ChildProcess.spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ...controlPlaneEnv(), T3CODE_HOME: baseDir },
});
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
  await NodeFSP.writeFile(NodePath.join(runtimeDir, "cli-launcher.mjs"), cliLauncher, {
    mode: 0o700,
  });

  const binDir = NodePath.join(NodeOS.homedir(), ".local", "bin");
  await NodeFSP.mkdir(binDir, { recursive: true });
  const wrapper = renderCliWrapper(baseDir, process.execPath);
  await NodeFSP.writeFile(NodePath.join(binDir, "sovereign"), wrapper, { mode: 0o700 });
  // Retain the old entry point as an update-in-place and rollback alias. Both
  // wrappers execute the same signed runtime, whose displayed command is
  // Sovereign.
  await NodeFSP.writeFile(NodePath.join(binDir, "t3"), wrapper, { mode: 0o700 });
  return binDir;
}

function readConnectStatus(entryPath, baseDir, runtimeEnv) {
  try {
    return JSON.parse(
      NodeChildProcess.execFileSync(process.execPath, [entryPath, "connect", "status", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...runtimeEnv, T3CODE_HOME: baseDir },
      }),
    );
  } catch {
    return undefined;
  }
}

function isBackgroundServiceActive() {
  if (process.platform === "linux") {
    return (
      NodeChildProcess.spawnSync(
        "systemctl",
        ["--user", "is-active", "--quiet", "t3code.service"],
        {
          stdio: "ignore",
        },
      ).status === 0
    );
  }
  if (process.platform === "darwin") {
    return (
      NodeChildProcess.spawnSync(
        "launchctl",
        ["print", `gui/${process.getuid()}/com.t3tools.t3code.service`],
        { stdio: "ignore" },
      ).status === 0
    );
  }
  return false;
}

function isBackgroundServiceInstalled() {
  if (process.platform === "darwin") return isBackgroundServiceActive();
  if (process.platform !== "linux") return false;
  return (
    NodeChildProcess.spawnSync("systemctl", ["--user", "cat", "--quiet", "t3code.service"], {
      stdio: "ignore",
    }).status === 0
  );
}

function reconcileInstalledBackgroundService(entryPath, baseDir, runtimeEnv) {
  if (!isBackgroundServiceInstalled()) return;
  NodeChildProcess.execFileSync(process.execPath, [entryPath, "service", "update"], {
    stdio: "inherit",
    env: { ...process.env, ...runtimeEnv, T3CODE_HOME: baseDir },
  });
  if (!isBackgroundServiceActive()) {
    throw new Error("The updated Sovereign background service did not become active.");
  }
}

function runRequestedCommand(entryPath, baseDir, command, runtimeEnv) {
  if (command[0] === "serve") {
    const status = readConnectStatus(entryPath, baseDir, runtimeEnv);
    if (status?.desired !== true || status.authenticated !== true) {
      NodeChildProcess.execFileSync(process.execPath, [entryPath, "connect", "--headless"], {
        stdio: "inherit",
        env: { ...process.env, ...runtimeEnv, T3CODE_HOME: baseDir },
      });
    }
    // `t3 connect` offers to install and starts the durable user service. Do
    // not start a competing foreground server when that onboarding succeeded.
    if (isBackgroundServiceActive()) {
      process.stdout.write("Sovereign server is running as sovereign.service.\n");
      return;
    }
  }
  NodeChildProcess.execFileSync(process.execPath, [entryPath, ...command], {
    stdio: "inherit",
    env: { ...process.env, ...runtimeEnv, T3CODE_HOME: baseDir },
  });
}

async function main() {
  resolveRuntimeTarget();
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    major < 22 ||
    (major === 22 && minor < 16) ||
    (major === 23 && minor < 11) ||
    (major === 24 && minor < 10)
  ) {
    throw new Error("Node 22.16 or newer is required.");
  }
  NodeChildProcess.execFileSync("tar", ["--version"], { stdio: "ignore" });
  const { command, requestedVersion } = parseArguments(process.argv.slice(2));
  const version = await resolveVersion(requestedVersion);
  const baseDir = NodePath.resolve(
    process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".local", "state", "t3-sovereign"),
  );
  const runtimeEnv = await configureRuntimeSettings(baseDir, command);
  const entryPath = await installRuntime(baseDir, version, runtimeEnv);
  const binDir = await configureInstallation(baseDir, version);
  // An installed boot service is launcher-pinned through service-state.json.
  // Merely writing current-version would leave both the stable CLI wrapper and
  // the live child on the previous release. Reconcile through the runtime's
  // service command so it replaces the launcher/state atomically and restarts
  // the service, while preserving the existing repair path on failure.
  reconcileInstalledBackgroundService(entryPath, baseDir, runtimeEnv);
  process.stdout.write(`Installed verified Sovereign ${version}.\n`);
  if (!(process.env.PATH ?? "").split(NodePath.delimiter).includes(binDir)) {
    process.stdout.write(`Add ${binDir} to PATH to use the sovereign command in future shells.\n`);
  }
  if (command.length > 0) {
    runRequestedCommand(entryPath, baseDir, command, runtimeEnv);
  }
}

export async function runInstaller() {
  try {
    await main();
  } catch (cause) {
    const childStatus =
      typeof cause === "object" &&
      cause !== null &&
      "status" in cause &&
      Number.isInteger(cause.status)
        ? cause.status
        : undefined;
    const message =
      childStatus === 130
        ? "Installation cancelled."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    process.stderr.write(`Sovereign installer failed: ${message}\n`);
    process.exitCode =
      childStatus !== undefined && childStatus > 0 && childStatus <= 255 ? childStatus : 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await runInstaller();
