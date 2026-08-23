/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI/build script. */
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import { deriveSovereignVersion } from "./artifact-format.mjs";

const defaultPackagePaths = [
  new URL("../../../apps/server/package.json", import.meta.url),
  new URL("../../../apps/web/package.json", import.meta.url),
];

async function loadSovereignPackages({ commit, packagePaths = defaultPackagePaths }) {
  if (!commit) throw new Error("GITEA_SHA, GITHUB_SHA, or SOURCE_COMMIT is required.");
  const packages = await Promise.all(
    packagePaths.map(async (packagePath) => ({
      packagePath,
      packageJson: JSON.parse(await NodeFSP.readFile(packagePath, "utf8")),
    })),
  );
  const baseVersions = new Set(
    packages.map(({ packageJson }) => String(packageJson.version).split(/[+-]/u, 1)[0]),
  );
  if (baseVersions.size !== 1) {
    throw new Error("Sovereign server and web package base versions must match.");
  }
  const [baseVersion] = baseVersions;
  return {
    packages,
    version: deriveSovereignVersion(baseVersion, commit),
  };
}

export async function deriveSovereignPackageVersion(options) {
  const { version } = await loadSovereignPackages(options);
  return version;
}

export async function setSovereignPackageVersions(options) {
  const { packages, version } = await loadSovereignPackages(options);
  await Promise.all(
    packages.map(async ({ packagePath, packageJson }) => {
      packageJson.version = version;
      await NodeFSP.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    }),
  );
  return version;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const printOnly = arguments_.length === 1 && arguments_[0] === "--print-only";
  if (arguments_.length > 0 && !printOnly) {
    throw new Error("Usage: set-runtime-version.mjs [--print-only]");
  }
  const options = {
    commit: process.env.GITEA_SHA ?? process.env.GITHUB_SHA ?? process.env.SOURCE_COMMIT,
  };
  const version = printOnly
    ? await deriveSovereignPackageVersion(options)
    : await setSovereignPackageVersions(options);
  process.stdout.write(`${version}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === NodeURL.pathToFileURL(invokedPath).href) {
  await main();
}
