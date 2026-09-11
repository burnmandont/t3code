/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI dispatcher. */

const API_VERSION = "2022-11-28";
const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 60 * 60_000;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function createDarwinRuntimeDispatch({ commitSha, runtimeVersion }) {
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw new Error("Darwin runtime commit SHA is invalid.");
  if (!/^\d+\.\d+\.\d+\+sovereign\.g[a-f0-9]{12}$/u.test(runtimeVersion)) {
    throw new Error("Darwin runtime version is invalid.");
  }
  if (!runtimeVersion.endsWith(commitSha.slice(0, 12))) {
    throw new Error("Darwin runtime version does not match its commit.");
  }
  return {
    event_type: "sovereign_darwin_runtime",
    client_payload: { commit_sha: commitSha, runtime_version: runtimeVersion },
  };
}

function githubClient(repository, token) {
  return async (path, options = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "t3-sovereign-darwin-dispatcher",
        "X-GitHub-Api-Version": API_VERSION,
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    return response;
  };
}

async function main() {
  const repository = required("SOVEREIGN_GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("SOVEREIGN_GITHUB_REPOSITORY must be owner/repository.");
  }
  const token = required("SOVEREIGN_GITHUB_BUILDER_TOKEN");
  const payload = createDarwinRuntimeDispatch({
    commitSha: required("GITEA_SHA"),
    runtimeVersion: required("SOVEREIGN_RUNTIME_VERSION"),
  });
  const request = githubClient(repository, token);
  const dispatchedAt = new Date(Date.now() - 5_000).toISOString();
  const dispatch = await request("/dispatches", { method: "POST", body: JSON.stringify(payload) });
  if (dispatch.status !== 204) {
    throw new Error(
      `Dispatching Darwin runtime failed (${dispatch.status}): ${await dispatch.text()}`,
    );
  }

  const expectedTitle = `Darwin runtime ${payload.client_payload.commit_sha}`;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await request("/actions/runs?event=repository_dispatch&per_page=50");
    if (!response.ok)
      throw new Error(`Reading Darwin runtime workflow runs failed (${response.status}).`);
    const document = await response.json();
    const run = document.workflow_runs?.find(
      (candidate) =>
        candidate.display_title === expectedTitle && candidate.created_at >= dispatchedAt,
    );
    if (run?.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`Darwin runtime workflow ${run.html_url} concluded ${run.conclusion}.`);
      }
      process.stdout.write(`DARWIN_RUNTIME_RUN_ID=${run.id}\n`);
      process.stdout.write(`Darwin runtime built by ${run.html_url}.\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for the Darwin runtime workflow.");
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
