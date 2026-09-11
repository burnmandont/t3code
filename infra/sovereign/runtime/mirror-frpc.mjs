/* oxlint-disable t3code/no-global-process-runtime -- Standalone operator script has no Effect runtime. */
import * as NodeCrypto from "node:crypto";
import { resolveRuntimePlatform } from "./runtime-platform.mjs";

const target = resolveRuntimePlatform();
const upstreamUrl = `https://github.com/fatedier/frp/releases/download/v0.70.1/${target.frpcArchiveDirectory}.tar.gz`;
const expectedSha256 = target.frpcSha256;
const destinationUrl = process.env.SOVEREIGN_FRPC_ASSET_URL;
const username = process.env.SOVEREIGN_PACKAGE_USERNAME;
const token = process.env.SOVEREIGN_PACKAGE_TOKEN;
if (!destinationUrl || !username || !token || new URL(destinationUrl).protocol !== "https:") {
  throw new Error("SOVEREIGN_FRPC_ASSET_URL and Gitea package credentials are required.");
}
const authorization = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
const upstream = await fetch(upstreamUrl, {
  // GitHub release downloads redirect to a short-lived asset URL. This
  // request carries no Gitea credential, and the pinned digest authenticates
  // the resulting bytes. Authenticated Gitea requests below remain
  // redirect-denied so their Authorization header cannot cross origins.
  redirect: "follow",
  signal: AbortSignal.timeout(120_000),
});
if (!upstream.ok) throw new Error(`Upstream FRP download returned HTTP ${upstream.status}.`);
const bytes = Buffer.from(await upstream.arrayBuffer());
const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
if (digest !== expectedSha256) throw new Error("Upstream FRP checksum did not match the pin.");

const published = await fetch(destinationUrl, {
  method: "PUT",
  headers: { Authorization: authorization, "Content-Length": String(bytes.length) },
  body: bytes,
  redirect: "error",
});
if (published.status === 201) {
  process.stdout.write(`Mirrored verified FRP ${expectedSha256}.\n`);
} else if (published.status === 409) {
  const existing = await fetch(destinationUrl, {
    headers: { Authorization: authorization },
    redirect: "error",
  });
  const existingBytes = Buffer.from(await existing.arrayBuffer());
  if (
    !existing.ok ||
    NodeCrypto.createHash("sha256").update(existingBytes).digest("hex") !== expectedSha256
  ) {
    throw new Error("The immutable FRP mirror path contains unexpected bytes.");
  }
  process.stdout.write(`Verified existing FRP mirror ${expectedSha256}.\n`);
} else {
  throw new Error(`FRP mirror upload returned HTTP ${published.status}: ${await published.text()}`);
}
