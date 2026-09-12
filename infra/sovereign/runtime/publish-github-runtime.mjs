import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { createSignedEnvelope } from "./artifact-format.mjs";
import { renderInstaller } from "./render-installer.mjs";
import {
  resolveRuntimePlatform,
  runtimeArtifactNames,
  SUPPORTED_RUNTIME_PLATFORMS,
} from "./runtime-platform.mjs";

const API_VERSION = "2022-11-28";

export function createStableChannelEnvelope(input) {
  if (!/^\d+\.\d+\.\d+\+sovereign\.g[a-f0-9]{7,64}$/u.test(input.version)) {
    throw new Error("Stable channel version is invalid.");
  }
  if (!/^[a-f0-9]{7,64}$/u.test(input.commit)) throw new Error("Git commit is invalid.");
  if (!input.version.endsWith(`g${input.commit.slice(0, 12)}`)) {
    throw new Error("Stable channel version does not match its commit.");
  }
  return createSignedEnvelope(
    {
      schemaVersion: 1,
      channel: "stable",
      version: input.version,
      commit: input.commit,
    },
    input.privateKeyPkcs8B64,
  );
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value ?? "")) {
    throw new Error("SOVEREIGN_GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  return value;
}

function validatePagesOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("SOVEREIGN_GITHUB_PAGES_ORIGIN must be a credentialless HTTPS origin.");
  }
  return url.origin;
}

async function digestFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function digestResponse(response) {
  if (response.body === null) throw new Error("GitHub asset response had no body.");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

function makeGitHubClient(token) {
  const request = async (url, options = {}) => {
    const response = await fetch(url.startsWith("https:") ? url : `https://api.github.com${url}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "t3-sovereign-runtime-publisher",
        ...options.headers,
      },
      redirect: options.redirect ?? "follow",
    });
    if (new URL(response.url).protocol !== "https:") {
      throw new Error("GitHub redirected a request away from HTTPS.");
    }
    return response;
  };

  const json = async (url, options = {}) => {
    const response = await request(url, options);
    if (!response.ok) {
      throw new Error(
        `GitHub API ${options.method ?? "GET"} ${url} returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  };
  return { json, request };
}

async function ensureRelease(client, repository, version) {
  const tag = `runtime-${version}`;
  const existing = await client.request(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (existing.ok) return existing.json();
  if (existing.status !== 404) {
    throw new Error(`Looking up GitHub release ${tag} returned HTTP ${existing.status}.`);
  }
  return client.json(`/repos/${repository}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: `Sovereign runtime ${version}`,
      body: "Immutable signed runtime artifact published by sovereign CI.",
      draft: true,
      prerelease: false,
    }),
  });
}

async function ensureReleaseAsset(client, repository, release, path) {
  const name = NodePath.basename(path);
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing !== undefined) {
    const response = await client.request(`/repos/${repository}/releases/assets/${existing.id}`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (!response.ok || (await digestResponse(response)) !== (await digestFile(path))) {
      throw new Error(`GitHub release already contains different bytes for immutable ${name}.`);
    }
    process.stdout.write(`Verified existing GitHub release asset ${name}.\n`);
    return existing;
  }
  const file = await NodeFSP.stat(path);
  const uploadUrl = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const response = await client.request(uploadUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
    },
    body: NodeFS.createReadStream(path),
    duplex: "half",
    redirect: "error",
  });
  if (response.status !== 201) {
    throw new Error(`Publishing GitHub release asset ${name} returned HTTP ${response.status}.`);
  }
  process.stdout.write(`Published GitHub release asset ${name}.\n`);
  return response.json();
}

async function publishRelease(client, repository, release) {
  if (!release.draft) return;
  await client.json(`/repos/${repository}/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // Runtime releases are addressed by their exact signed tag. Keep GitHub's
    // `latest` pointer reserved for the complete desktop updater release.
    body: JSON.stringify({ draft: false, make_latest: "false" }),
  });
  process.stdout.write(`Published GitHub release ${release.tag_name}.\n`);
}

export function assertCompleteRuntimeRelease(release) {
  const names = new Set(release.assets.map((asset) => asset.name));
  for (const [key, target] of Object.entries(SUPPORTED_RUNTIME_PLATFORMS)) {
    const expected = runtimeArtifactNames({ key, ...target });
    for (const name of [expected.artifactFileName, expected.manifestFileName]) {
      if (!names.has(name)) throw new Error(`Runtime release is missing required asset ${name}.`);
    }
  }
}

export function resolveRuntimeOutputDirs(primaryOutputDir, additionalOutputDirs = "") {
  const outputDirs = [primaryOutputDir, ...additionalOutputDirs.split(NodePath.delimiter)]
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => NodePath.resolve(path));
  return [...new Set(outputDirs)];
}

async function readRuntimeBuild(outputDir, version, commit) {
  const build = JSON.parse(await NodeFSP.readFile(NodePath.join(outputDir, "build.json"), "utf8"));
  const target = resolveRuntimePlatform(build.platform, build.arch);
  if (build.version !== version || build.commit !== commit) {
    throw new Error(
      `Built ${target.key} runtime identity does not match the requested publication.`,
    );
  }
  const publicKey = (
    await NodeFSP.readFile(NodePath.join(outputDir, "public-key-spki.b64"), "utf8")
  ).trim();
  return { build, outputDir, publicKey, target, ...runtimeArtifactNames(target) };
}

async function putRepositoryFile(client, repository, branch, path, bytes, message) {
  const encodedPath = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const existing = await client.request(
    `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
  );
  let sha;
  if (existing.ok) {
    const document = await existing.json();
    const current = Buffer.from(document.content.replace(/\s/gu, ""), "base64");
    if (current.equals(bytes)) {
      process.stdout.write(`Verified existing GitHub Pages file ${path}.\n`);
      return;
    }
    sha = document.sha;
  } else if (existing.status !== 404) {
    throw new Error(`Reading GitHub Pages file ${path} returned HTTP ${existing.status}.`);
  }
  await client.json(`/repos/${repository}/contents/${encodedPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: bytes.toString("base64"),
      branch,
      ...(sha === undefined ? {} : { sha }),
    }),
  });
  process.stdout.write(`Published GitHub Pages file ${path}.\n`);
}

async function main() {
  const repository = validateRepository(process.env.SOVEREIGN_GITHUB_REPOSITORY);
  const pagesOrigin = validatePagesOrigin(process.env.SOVEREIGN_GITHUB_PAGES_ORIGIN);
  const token = process.env.SOVEREIGN_GITHUB_TOKEN;
  const privateKey = process.env.SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64;
  const version = process.env.SOVEREIGN_RUNTIME_VERSION;
  const commit = process.env.GITEA_SHA ?? process.env.GITHUB_SHA;
  const publishStableChannel = process.env.SOVEREIGN_PUBLISH_STABLE_CHANNEL !== "0";
  const outputDir = NodePath.resolve(
    process.env.SOVEREIGN_RUNTIME_OUTPUT_DIR ?? "infra/sovereign/dist/runtime",
  );
  const outputDirs = resolveRuntimeOutputDirs(
    outputDir,
    process.env.SOVEREIGN_ADDITIONAL_RUNTIME_OUTPUT_DIRS,
  );
  if (!token || !privateKey || !version || !commit) {
    throw new Error(
      "GitHub token, runtime signing key, runtime version, and Git commit are required.",
    );
  }
  const builds = await Promise.all(
    outputDirs.map((runtimeOutputDir) => readRuntimeBuild(runtimeOutputDir, version, commit)),
  );
  const targetKeys = new Set(builds.map(({ target }) => target.key));
  if (targetKeys.size !== builds.length) {
    throw new Error("Runtime publication contains the same platform more than once.");
  }
  const publicKey = builds[0]?.publicKey;
  if (!publicKey || builds.some((build) => build.publicKey !== publicKey)) {
    throw new Error("Runtime platform builds do not share one signing public key.");
  }
  const channel = createStableChannelEnvelope({
    version,
    commit,
    privateKeyPkcs8B64: privateKey,
  });
  if (channel.publicKeySpkiB64 !== publicKey) {
    throw new Error("Built runtime public key does not match the stable-channel signing key.");
  }
  const releaseBaseUrl = `https://github.com/${repository}/releases/download`;
  const installerModule = await NodeFSP.readFile(
    NodePath.join(NodePath.dirname(new URL(import.meta.url).pathname), "bootstrap-installer.mjs"),
    "utf8",
  );
  const installer = renderInstaller({
    moduleSource: installerModule,
    channelUrl: `${pagesOrigin}/channels/stable.json`,
    releaseBaseUrl,
    publicKeySpkiB64: publicKey,
  });

  const client = makeGitHubClient(token);
  const repositoryDocument = await client.json(`/repos/${repository}`);
  const branch = repositoryDocument.default_branch;
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("The GitHub artifact repository has no default branch.");
  }
  const release = await ensureRelease(client, repository, version);
  const assets = [...release.assets];
  for (const build of builds) {
    for (const name of [build.artifactFileName, build.manifestFileName]) {
      const asset = await ensureReleaseAsset(
        client,
        repository,
        { ...release, assets },
        NodePath.join(build.outputDir, name),
      );
      const existingIndex = assets.findIndex((candidate) => candidate.name === asset.name);
      if (existingIndex === -1) assets.push(asset);
      else assets[existingIndex] = asset;
    }
  }
  const completeRelease = { ...release, assets };
  if (publishStableChannel) assertCompleteRuntimeRelease(completeRelease);
  await publishRelease(client, repository, completeRelease);

  if (publishStableChannel) {
    const message = `release: publish sovereign runtime ${version}`;
    await putRepositoryFile(client, repository, branch, "install", Buffer.from(installer), message);
    await putRepositoryFile(
      client,
      repository,
      branch,
      "CNAME",
      Buffer.from(`${new URL(pagesOrigin).hostname}\n`),
      message,
    );
    // The signed channel moves last, after every required platform publisher
    // has completed and the bootstrap knows how to select those assets.
    await putRepositoryFile(
      client,
      repository,
      branch,
      "channels/stable.json",
      Buffer.from(`${JSON.stringify(channel.envelope)}\n`),
      message,
    );
  }
  process.stdout.write(
    `Published sovereign ${builds.map(({ target }) => target.key).join(", ")} runtime ${version} to GitHub${publishStableChannel ? " and advanced stable" : ""}.\n`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
