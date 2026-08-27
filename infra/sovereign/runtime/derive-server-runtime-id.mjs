import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const SERVER_RUNTIME_SOURCE_PATHS = Object.freeze([
  "apps/server",
  "packages/contracts",
  "packages/effect-acp",
  "packages/effect-codex-app-server",
  "packages/shared",
  "packages/tailscale",
  "patches/@ff-labs__fff-node@0.10.3.patch",
  "patches/effect@4.0.0-beta.103.patch",
  "scripts/lib/cli-external-packages.ts",
  "scripts/lib/public-config.ts",
  "vite.config.ts",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".turbo",
  ".vite-plus",
  "coverage",
  "dist",
  "node_modules",
]);

const IGNORED_SOURCE_DIRECTORY_NAMES = new Set([
  "__snapshots__",
  "__tests__",
  "integration",
  "test",
  "testFixtures",
  "tests",
]);

export function isServerRuntimeSourcePath(relativePath) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => IGNORED_SOURCE_DIRECTORY_NAMES.has(segment))) return false;
  return !/\.(?:integration\.)?(?:spec|test)\.[^/]+$/u.test(relativePath);
}

export function deriveServerRuntimeId(entries) {
  const canonical = entries
    .map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.path !== "string" ||
        typeof entry.contentHash !== "string" ||
        entry.path.length === 0 ||
        !/^[a-f0-9]{64}$/u.test(entry.contentHash)
      ) {
        throw new Error("Server runtime source entry is invalid.");
      }
      return `${entry.path}\0${entry.contentHash}`;
    })
    .sort();
  if (canonical.length === 0) throw new Error("Server runtime source closure is empty.");
  const digest = NodeCrypto.createHash("sha256")
    .update("t3-server-runtime-source-v1\0")
    .update(canonical.join("\0"))
    .digest("hex");
  return `sha256:${digest}`;
}

async function contentHash(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readServerRuntimeSourceEntries({ repoRoot }) {
  const entries = [];
  const visit = async (relativePath) => {
    const absolutePath = NodePath.join(repoRoot, relativePath);
    const stat = await NodeFSP.lstat(absolutePath);
    if (stat.isDirectory()) {
      const children = await NodeFSP.readdir(absolutePath, { withFileTypes: true });
      for (const child of children) {
        if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name)) continue;
        await visit(NodePath.posix.join(relativePath, child.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported server runtime source: ${relativePath}`);
    if (!isServerRuntimeSourcePath(relativePath)) return;
    entries.push({ path: relativePath, contentHash: await contentHash(absolutePath) });
  };
  for (const path of SERVER_RUNTIME_SOURCE_PATHS) await visit(path);
  return entries;
}

export async function deriveServerRuntimeIdFromSource(options) {
  return deriveServerRuntimeId(await readServerRuntimeSourceEntries(options));
}

async function main() {
  const repoRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../..",
  );
  process.stdout.write(`${await deriveServerRuntimeIdFromSource({ repoRoot })}\n`);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await main();
}
