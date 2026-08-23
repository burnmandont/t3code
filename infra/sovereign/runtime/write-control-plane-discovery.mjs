import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

function required(name, ...aliases) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required control-plane discovery value: ${name}.`);
}

function origin(value, name) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be a credential-free HTTPS origin.`);
  }
  return url.origin;
}

function publicUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  return url.toString().replace(/\/$/u, "");
}

const hostedAppUrl = origin(
  required("VITE_HOSTED_APP_URL", "T3CODE_HOSTED_APP_URL"),
  "Hosted app URL",
);
const document = {
  schemaVersion: 1,
  runtimeVersion: required("SOVEREIGN_RUNTIME_VERSION"),
  origin: hostedAppUrl,
  hostedAppUrl,
  oauthIssuer: publicUrl(required("T3CODE_OAUTH_ISSUER"), "OAuth issuer"),
  oauthClientId: required("T3CODE_OAUTH_CLIENT_ID"),
  oauthResource: publicUrl(required("T3CODE_OAUTH_RESOURCE"), "OAuth resource"),
  relayUrl: origin(required("T3CODE_RELAY_URL"), "Relay URL"),
};

const output = NodePath.resolve(process.argv[2] ?? "apps/web/public/.well-known/t3-sovereign.json");
await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
await NodeFSP.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(`Wrote sovereign control-plane discovery to ${output}.\n`);
