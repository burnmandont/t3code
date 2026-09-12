import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const vitePlus = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vp.cmd" : "vp",
);

const suites = [
  {
    name: "product contracts and opinions",
    workspace: "packages/contracts",
    files: ["src/settings.test.ts", "src/orchestration.test.ts"],
  },
  {
    name: "multi-route connections, credential renewal, and bounded terminal input",
    workspace: "packages/client-runtime",
    files: [
      "src/authorization/layer.test.ts",
      "src/connection/resolver.test.ts",
      "src/connection/supervisor.test.ts",
      "src/state/environmentHttpAuth.test.ts",
      "src/state/terminalInput.test.ts",
    ],
  },
  {
    name: "SSH server ownership and native forwarding",
    workspace: "packages/ssh",
    files: ["src/tunnel.test.ts"],
  },
  {
    name: "project notes, relay selection, streaming, migrations, and forwarding",
    workspace: "apps/server",
    files: [
      "src/cloud/providerSelection.test.ts",
      "src/cloud/runtimeArtifact.test.ts",
      "src/orchestration/decider.projectScripts.test.ts",
      "src/orchestration/ThreadLiveEventCoalescer.test.ts",
      "src/persistence/Migrations/042_ProjectionProjectNotes.test.ts",
      "src/portForward/TcpForwardBridge.test.ts",
    ],
  },
  {
    name: "project notes, pinned divider, and required web workflow",
    workspace: "apps/web",
    args: ["--project", "unit"],
    files: [
      "src/components/ProjectNotesControl.test.tsx",
      "src/components/Sidebar.logic.test.ts",
      "src/components/chat/MessagesTimeline.logic.test.ts",
      "src/components/cloud/CloudEnvironmentConnectList.test.tsx",
      "src/components/composerFooterLayout.test.ts",
    ],
  },
  {
    name: "Sovereign desktop identity, focus, preferences, and port forwarding",
    workspace: "apps/desktop",
    files: [
      "src/app/DesktopSovereignAuth.test.ts",
      "src/portForward/DesktopPortForwardManager.test.ts",
      "src/preview/Manager.test.ts",
      "src/preview/PreviewKeyboard.test.ts",
      "src/settings/DesktopClientSettings.test.ts",
    ],
  },
  {
    name: "Sovereign mobile identity and environment routing",
    workspace: "apps/mobile",
    files: [
      "src/features/cloud/sovereignMobileAuth.test.ts",
      "src/features/connection/environmentSections.test.ts",
    ],
  },
  {
    name: "self-hosted account and OAuth boundary",
    workspace: "infra/account",
    files: ["src/config.test.ts", "src/oidcHandler.test.ts"],
  },
  {
    name: "operator relay, DPoP, and authenticated FRP boundary",
    workspace: "infra/relay",
    files: [
      "src/auth/RelayTokens.test.ts",
      "src/environments/EnvironmentConnector.test.ts",
      "src/frp/FrpAuthorization.test.ts",
      "src/sovereign.test.ts",
    ],
  },
  {
    name: "Sovereign branding and signed desktop distribution",
    workspace: "scripts",
    files: ["build-desktop-artifact.test.ts", "sovereign-desktop.test.ts"],
  },
];

const operationalTests = [
  "infra/sovereign/backup/backup.test.mjs",
  "infra/sovereign/ci/deploy-and-verify.test.mjs",
  "infra/sovereign/monitor/monitor.test.mjs",
  "infra/sovereign/runtime/artifact-format.test.mjs",
];

function requireFiles(files) {
  for (const file of files) {
    if (!existsSync(path.join(repositoryRoot, file))) {
      throw new Error(`Sovereign invariant test is missing: ${file}`);
    }
  }
}

function run(command, args, label) {
  process.stdout.write(`\n=== Sovereign invariant: ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (!existsSync(vitePlus)) {
  throw new Error(`Vite+ executable is missing: ${vitePlus}`);
}

for (const suite of suites) {
  const repositoryFiles = suite.files.map((file) => path.join(suite.workspace, file));
  requireFiles(repositoryFiles);
  if (
    !run(
      vitePlus,
      ["-C", suite.workspace, "test", "run", ...(suite.args ?? []), ...suite.files],
      suite.name,
    )
  ) {
    break;
  }
}

if (process.exitCode === undefined) {
  requireFiles(operationalTests);
  run(process.execPath, ["--test", ...operationalTests], "deployment and operational boundaries");
}
