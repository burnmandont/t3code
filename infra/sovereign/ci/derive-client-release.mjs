/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI helper. */

export function deriveClientRelease({ baseVersion, runNumber }) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(baseVersion ?? "");
  if (!match) throw new Error("Client base version must be stable SemVer.");
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || runNumber > 99_999) {
    throw new Error("Gitea run number must be an integer between 1 and 99999.");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const releaseNumber = patch * 100_000 + runNumber;
  return {
    desktopVersion: `${major}.${minor}.${releaseNumber}`,
    iosBuildNumber: String(100_000 + runNumber),
  };
}

async function main() {
  const baseVersion = process.env.SOVEREIGN_CLIENT_BASE_VERSION;
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER ?? process.env.GITEA_RUN_NUMBER);
  const release = deriveClientRelease({ baseVersion, runNumber });
  const output = [
    `SOVEREIGN_DESKTOP_VERSION=${release.desktopVersion}`,
    `T3CODE_IOS_BUILD_NUMBER=${release.iosBuildNumber}`,
  ].join("\n");
  if (process.argv.includes("--github-env")) {
    const path = process.env.GITHUB_ENV;
    if (!path) throw new Error("GITHUB_ENV is required with --github-env.");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, `${output}\n`);
  }
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
