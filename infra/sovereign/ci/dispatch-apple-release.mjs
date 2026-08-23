/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI dispatcher. */

const API_VERSION = "2022-11-28";
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const IOS_BUILD_NUMBER_PATTERN = /^[1-9]\d*$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function createAppleReleaseDispatch({ commitSha, desktopVersion, iosBuildNumber }) {
  if (!COMMIT_SHA_PATTERN.test(commitSha)) throw new Error("Apple release commit SHA is invalid.");
  if (!VERSION_PATTERN.test(desktopVersion)) {
    throw new Error("Apple desktop release version is invalid.");
  }
  if (!IOS_BUILD_NUMBER_PATTERN.test(iosBuildNumber)) {
    throw new Error("Apple iOS release build number is invalid.");
  }
  return {
    event_type: "sovereign_apple_release",
    client_payload: {
      commit_sha: commitSha,
      desktop_version: desktopVersion,
      ios_build_number: iosBuildNumber,
    },
  };
}

async function main() {
  const repository = required("SOVEREIGN_GITHUB_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("SOVEREIGN_GITHUB_REPOSITORY must be owner/repository.");
  }
  const token = required("SOVEREIGN_GITHUB_BUILDER_TOKEN");
  const payload = createAppleReleaseDispatch({
    commitSha: required("GITEA_SHA"),
    desktopVersion: required("SOVEREIGN_DESKTOP_VERSION"),
    iosBuildNumber: required("T3CODE_IOS_BUILD_NUMBER"),
  });
  const response = await fetch(`https://api.github.com/repos/${repository}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "t3-sovereign-apple-dispatcher",
      "X-GitHub-Api-Version": API_VERSION,
    },
    body: JSON.stringify(payload),
  });
  if (response.status !== 204) {
    throw new Error(
      `Dispatching the Apple release failed (${response.status}): ${await response.text()}`,
    );
  }
  process.stdout.write(
    `Dispatched sovereign desktop ${payload.client_payload.desktop_version} and iOS build ${payload.client_payload.ios_build_number} from ${payload.client_payload.commit_sha}.\n`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
