/* oxlint-disable t3code/no-global-process-runtime -- Standalone operator script has no Effect runtime. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const baseDir = NodePath.resolve(
  process.env.T3CODE_HOME ?? NodePath.join(process.env.HOME ?? "", ".t3"),
);
const baseUrl = process.env.SOVEREIGN_PACKAGE_BASE_URL;
const publicKeySpkiB64 = process.env.SOVEREIGN_RUNTIME_SIGNING_PUBLIC_KEY_B64;
const username = process.env.SOVEREIGN_PACKAGE_USERNAME;
const token = process.env.SOVEREIGN_PACKAGE_TOKEN;
if (!baseUrl || !publicKeySpkiB64) {
  throw new Error(
    "SOVEREIGN_PACKAGE_BASE_URL and SOVEREIGN_RUNTIME_SIGNING_PUBLIC_KEY_B64 are required.",
  );
}
if ((username === undefined) !== (token === undefined)) {
  throw new Error(
    "SOVEREIGN_PACKAGE_USERNAME and SOVEREIGN_PACKAGE_TOKEN must be provided together.",
  );
}
const url = new URL(baseUrl);
if (url.protocol !== "https:") throw new Error("The sovereign package URL must use HTTPS.");
const config = {
  schemaVersion: 1,
  baseUrl: baseUrl.replace(/\/$/u, ""),
  ...(username === undefined ? {} : { username, token }),
  publicKeySpkiB64,
};
const destination = NodePath.join(baseDir, "runtime", "artifact-source.json");
const temporary = `${destination}.${process.pid}.tmp`;
await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
await NodeFSP.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
await NodeFSP.rename(temporary, destination);
process.stdout.write(`Configured fail-closed sovereign artifacts at ${destination}.\n`);
