/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI artifact retrieval. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repository = process.env.SOVEREIGN_GITHUB_REPOSITORY;
const token = process.env.SOVEREIGN_GITHUB_BUILDER_TOKEN;
const runId = process.env.SOVEREIGN_DARWIN_RUNTIME_RUN_ID;
const outputDir = NodePath.resolve(
  process.env.SOVEREIGN_RUNTIME_OUTPUT_DIR ?? "infra/sovereign/dist/runtime",
);
if (!repository || !token || !/^\d+$/u.test(runId ?? "")) {
  throw new Error("GitHub repository, token, and Darwin runtime run ID are required.");
}
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};
const artifacts = await fetch(
  `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`,
  {
    headers,
  },
);
if (!artifacts.ok)
  throw new Error(`Listing Darwin runtime artifacts returned HTTP ${artifacts.status}.`);
const document = await artifacts.json();
const artifact = document.artifacts?.find(
  (candidate) => candidate.name === `darwin-runtime-${process.env.GITEA_SHA}` && !candidate.expired,
);
if (!artifact)
  throw new Error("The completed Darwin workflow did not retain its runtime artifact.");
const archive = await fetch(artifact.archive_download_url, { headers, redirect: "manual" });
if (archive.status !== 302)
  throw new Error(`Downloading Darwin runtime artifact returned HTTP ${archive.status}.`);
const location = archive.headers.get("location");
if (!location || new URL(location).protocol !== "https:")
  throw new Error("Darwin artifact redirect is invalid.");
const download = await fetch(location, { redirect: "error" });
if (!download.ok)
  throw new Error(`Downloading Darwin runtime bytes returned HTTP ${download.status}.`);
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-darwin-runtime-"));
try {
  const zipPath = NodePath.join(temporary, "runtime.zip");
  await NodeFSP.writeFile(zipPath, Buffer.from(await download.arrayBuffer()), { mode: 0o600 });
  await NodeFSP.mkdir(outputDir, { recursive: true });
  NodeChildProcess.execFileSync("unzip", ["-qo", zipPath, "-d", outputDir], { stdio: "inherit" });
  process.stdout.write(`Downloaded Darwin runtime artifact from GitHub run ${runId}.\n`);
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
