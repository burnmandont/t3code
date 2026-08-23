/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI publisher. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const API_VERSION = "2022-11-28";
const DESKTOP_ASSET_PATTERN = /\.(?:dmg|zip|blockmap|yml)$/u;

export function selectDesktopReleaseAssets(entries) {
  const assets = entries.filter((entry) => DESKTOP_ASSET_PATTERN.test(entry)).sort();
  if (!assets.some((entry) => entry.endsWith(".dmg"))) {
    throw new Error("Desktop release has no DMG.");
  }
  if (!assets.some((entry) => entry.endsWith(".zip"))) {
    throw new Error("Desktop release has no ZIP update payload.");
  }
  if (!assets.includes("latest-mac.yml")) {
    throw new Error("Desktop release has no latest-mac.yml updater manifest.");
  }
  return assets;
}

export function readDesktopManifestVersion(manifest) {
  const line = manifest.match(/^version:\s*(.+?)\s*$/mu)?.[1];
  if (!line) throw new Error("latest-mac.yml has no desktop version.");
  if (
    line.length >= 2 &&
    ((line.startsWith("'") && line.endsWith("'")) || (line.startsWith('"') && line.endsWith('"')))
  ) {
    return line.slice(1, -1);
  }
  return line;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
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

function makeClient(token) {
  const request = async (url, options = {}) => {
    const response = await fetch(url.startsWith("https:") ? url : `https://api.github.com${url}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "t3-sovereign-desktop-publisher",
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
      throw new Error(`GitHub API request failed (${response.status}): ${await response.text()}`);
    }
    return response.json();
  };
  return { json, request };
}

async function ensureRelease(client, repository, version) {
  const tag = `desktop-v${version}`;
  const existing = await client.request(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (existing.ok) return existing.json();
  if (existing.status !== 404) throw new Error(`Looking up ${tag} failed (${existing.status}).`);
  return client.json(`/repos/${repository}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: `Sovereign desktop ${version}`,
      body: "Signed desktop release published automatically by sovereign CI.",
      draft: true,
      prerelease: false,
    }),
  });
}

async function ensureAsset(client, repository, release, path) {
  const name = NodePath.basename(path);
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) {
    const response = await client.request(`/repos/${repository}/releases/assets/${existing.id}`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (!response.ok || (await digestResponse(response)) !== (await digestFile(path))) {
      throw new Error(`GitHub release contains different bytes for immutable ${name}.`);
    }
    process.stdout.write(`Verified existing desktop asset ${name}.\n`);
    return;
  }
  const stat = await NodeFSP.stat(path);
  const response = await client.request(
    `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
      },
      body: NodeFS.createReadStream(path),
      duplex: "half",
      redirect: "error",
    },
  );
  if (response.status !== 201) throw new Error(`Publishing ${name} failed (${response.status}).`);
  process.stdout.write(`Published desktop asset ${name}.\n`);
}

async function main() {
  const repository = required("SOVEREIGN_GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("SOVEREIGN_GITHUB_REPOSITORY must be owner/repository.");
  }
  const token = required("SOVEREIGN_GITHUB_TOKEN");
  const version = required("SOVEREIGN_DESKTOP_VERSION");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Desktop version is invalid.");
  const outputDirectory = NodePath.resolve(process.env.SOVEREIGN_DESKTOP_OUTPUT_DIR ?? "release");
  const names = selectDesktopReleaseAssets(await NodeFSP.readdir(outputDirectory));
  const manifest = await NodeFSP.readFile(NodePath.join(outputDirectory, "latest-mac.yml"), "utf8");
  if (readDesktopManifestVersion(manifest) !== version) {
    throw new Error("latest-mac.yml does not contain the expected desktop version.");
  }
  const client = makeClient(token);
  const release = await ensureRelease(client, repository, version);
  for (const name of names) {
    await ensureAsset(client, repository, release, NodePath.join(outputDirectory, name));
  }
  if (release.draft) {
    await client.json(`/repos/${repository}/releases/${release.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false, make_latest: "true" }),
    });
  }
  process.stdout.write(`Published sovereign desktop ${version}.\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
