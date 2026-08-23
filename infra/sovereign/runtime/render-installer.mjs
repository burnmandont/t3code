/* oxlint-disable t3code/no-global-process-runtime -- Standalone CI script. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const TOKEN_PATTERN = /__SOVEREIGN_[A-Z0-9_]+__/gu;
const INSTALLER_DELIMITER = "__T3_SOVEREIGN_INSTALLER_3B9C90F2__";

function requireHttps(value, label) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must be a credentialless HTTPS URL.`);
  }
  return value.replace(/\/$/u, "");
}

export function renderInstaller(input) {
  const channelUrl = requireHttps(input.channelUrl, "Channel URL");
  const releaseBaseUrl = requireHttps(input.releaseBaseUrl, "Release base URL");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.publicKeySpkiB64)) {
    throw new Error("Runtime signing public key is not canonical base64.");
  }
  const renderedModule = input.moduleSource
    .replaceAll("__SOVEREIGN_CHANNEL_URL__", channelUrl)
    .replaceAll("__SOVEREIGN_RELEASE_BASE_URL__", releaseBaseUrl)
    .replaceAll("__SOVEREIGN_PUBLIC_KEY_SPKI_B64__", input.publicKeySpkiB64);
  const unresolved = renderedModule.match(TOKEN_PATTERN);
  if (unresolved !== null) throw new Error(`Installer still contains ${unresolved.join(", ")}.`);
  if (renderedModule.includes(INSTALLER_DELIMITER)) {
    throw new Error("Installer module collides with its shell delimiter.");
  }
  return `#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node 22.16 or newer is required to install sovereign T3." >&2
  exit 1
fi

node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
node_major="\${node_version%%.*}"
node_version_rest="\${node_version#*.}"
node_minor="\${node_version_rest%%.*}"
case "$node_major:$node_minor" in
  *[!0-9:]*|:|*:)
    echo "Could not determine the installed Node version. Node 22.16 or newer is required." >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 16 ]; }; then
  echo "Node 22.16 or newer is required to install sovereign T3; found Node $node_version." >&2
  exit 1
fi

installer_directory="$(mktemp -d "\${TMPDIR:-/tmp}/t3-sovereign-installer.XXXXXX")"
installer_module="$installer_directory/install.mjs"
cleanup_installer() {
  rm -rf -- "$installer_directory"
}
trap cleanup_installer EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

cat > "$installer_module" <<'${INSTALLER_DELIMITER}'
${renderedModule}
${INSTALLER_DELIMITER}

chmod 600 "$installer_module"
if [ -r /dev/tty ]; then
  node "$installer_module" "$@" < /dev/tty
else
  node "$installer_module" "$@"
fi
`;
}

async function main() {
  const modulePath = NodePath.join(
    NodePath.dirname(new URL(import.meta.url).pathname),
    "bootstrap-installer.mjs",
  );
  const outputPath = process.env.SOVEREIGN_INSTALLER_OUTPUT;
  const pagesOrigin = process.env.SOVEREIGN_GITHUB_PAGES_ORIGIN;
  const releaseBaseUrl = process.env.SOVEREIGN_GITHUB_RELEASE_BASE_URL;
  const publicKeySpkiB64 = process.env.SOVEREIGN_RUNTIME_SIGNING_PUBLIC_KEY_B64;
  if (!outputPath || !pagesOrigin || !releaseBaseUrl || !publicKeySpkiB64) {
    throw new Error(
      "SOVEREIGN_INSTALLER_OUTPUT, SOVEREIGN_GITHUB_PAGES_ORIGIN, " +
        "SOVEREIGN_GITHUB_RELEASE_BASE_URL, and SOVEREIGN_RUNTIME_SIGNING_PUBLIC_KEY_B64 are required.",
    );
  }
  const installer = renderInstaller({
    moduleSource: await NodeFSP.readFile(modulePath, "utf8"),
    channelUrl: `${pagesOrigin.replace(/\/$/u, "")}/channels/stable.json`,
    releaseBaseUrl,
    publicKeySpkiB64,
  });
  await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(outputPath)), { recursive: true });
  await NodeFSP.writeFile(outputPath, installer, { mode: 0o755 });
  process.stdout.write(`Rendered sovereign installer at ${outputPath}.\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
