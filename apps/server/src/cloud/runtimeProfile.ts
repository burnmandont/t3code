// @effect-diagnostics nodeBuiltinImport:off -- Shared by the standalone service launcher.
// @effect-diagnostics globalFetch:off -- Shared by the standalone bootstrap before Effect services are available.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const CONTROL_PLANE_PROFILE_FILE = "control-plane.json";
export const ENVIRONMENT_LABEL_FILE = "environment-label";
export const CONTROL_PLANE_DISCOVERY_PATH = "/.well-known/t3-sovereign.json";

export interface ControlPlaneProfile {
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly hostedAppUrl: string;
  readonly oauthIssuer: string;
  readonly oauthClientId: string;
  readonly oauthResource: string;
  readonly relayUrl: string;
}

const runtimeDirectory = (baseDir: string) => NodePath.join(baseDir, "runtime");
export const controlPlaneProfilePath = (baseDir: string) =>
  NodePath.join(runtimeDirectory(baseDir), CONTROL_PLANE_PROFILE_FILE);
export const environmentLabelPath = (baseDir: string) =>
  NodePath.join(runtimeDirectory(baseDir), ENVIRONMENT_LABEL_FILE);

function normalizePublicUrl(value: unknown, label: string, originOnly: boolean): string {
  if (typeof value !== "string") throw new Error(`${label} must be a URL.`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for loopback development).`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, a query, or a fragment.`);
  }
  if (originOnly && url.pathname !== "/") throw new Error(`${label} must be an origin.`);
  return originOnly ? url.origin : url.toString().replace(/\/$/u, "");
}

export function normalizeControlPlaneOrigin(value: string): string {
  return normalizePublicUrl(value, "Control-plane URL", true);
}

export function parseControlPlaneProfile(
  value: unknown,
  expectedOrigin?: string,
): ControlPlaneProfile {
  if (typeof value !== "object" || value === null) {
    throw new Error("Control-plane discovery document must be a JSON object.");
  }
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== 1) {
    throw new Error("Control-plane discovery schema is unsupported.");
  }
  const origin = normalizeControlPlaneOrigin(
    String(document.origin ?? document.hostedAppUrl ?? ""),
  );
  const hostedAppUrl = normalizePublicUrl(document.hostedAppUrl, "Hosted app URL", true);
  if (hostedAppUrl !== origin) {
    throw new Error("Control-plane discovery origin and hosted app URL must match.");
  }
  if (expectedOrigin !== undefined && origin !== normalizeControlPlaneOrigin(expectedOrigin)) {
    throw new Error("Control-plane discovery document does not describe the requested origin.");
  }
  const oauthIssuer = normalizePublicUrl(document.oauthIssuer, "OAuth issuer", false);
  const oauthClientId =
    typeof document.oauthClientId === "string" ? document.oauthClientId.trim() : "";
  if (!oauthClientId || oauthClientId.length > 256) {
    throw new Error("OAuth client ID is missing or invalid.");
  }
  const oauthResource = normalizePublicUrl(document.oauthResource, "OAuth resource", false);
  const relayUrl = normalizePublicUrl(document.relayUrl, "Relay URL", true);
  return {
    schemaVersion: 1,
    origin,
    hostedAppUrl,
    oauthIssuer,
    oauthClientId,
    oauthResource,
    relayUrl,
  };
}

export async function discoverControlPlane(origin: string): Promise<ControlPlaneProfile> {
  const normalizedOrigin = normalizeControlPlaneOrigin(origin);
  const response = await fetch(new URL(CONTROL_PLANE_DISCOVERY_PATH, normalizedOrigin), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Control-plane discovery returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > 64 * 1024) throw new Error("Control-plane discovery document is too large.");
  if (response.body === null) throw new Error("Control-plane discovery response has no body.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 64 * 1024) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Control-plane discovery document is too large.");
    }
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  return parseControlPlaneProfile(JSON.parse(text), normalizedOrigin);
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const directory = NodePath.dirname(filePath);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  try {
    await NodeFSP.writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readControlPlaneProfile(
  baseDir: string,
): Promise<ControlPlaneProfile | null> {
  try {
    return parseControlPlaneProfile(
      JSON.parse(await NodeFSP.readFile(controlPlaneProfilePath(baseDir), "utf8")),
    );
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

export async function writeControlPlaneProfile(
  baseDir: string,
  profile: ControlPlaneProfile,
): Promise<void> {
  const validated = parseControlPlaneProfile(profile);
  await atomicWrite(controlPlaneProfilePath(baseDir), `${JSON.stringify(validated, null, 2)}\n`);
}

export async function clearControlPlaneProfile(baseDir: string): Promise<void> {
  await NodeFSP.rm(controlPlaneProfilePath(baseDir), { force: true });
}

export function controlPlaneEnvironment(profile: ControlPlaneProfile | null) {
  return profile === null
    ? {}
    : {
        T3CODE_HOSTED_APP_URL: profile.hostedAppUrl,
        T3CODE_OAUTH_ISSUER: profile.oauthIssuer,
        T3CODE_OAUTH_CLIENT_ID: profile.oauthClientId,
        T3CODE_OAUTH_RESOURCE: profile.oauthResource,
        T3CODE_RELAY_URL: profile.relayUrl,
      };
}

export function normalizeEnvironmentLabel(value: string): string {
  const label = value.trim().replace(/\s+/gu, " ");
  if (!label) throw new Error("Environment label cannot be empty.");
  if (label.length > 100) throw new Error("Environment label must be 100 characters or fewer.");
  if (/\p{Cc}/u.test(label))
    throw new Error("Environment label cannot contain control characters.");
  return label;
}

export async function readEnvironmentLabel(baseDir: string): Promise<string | null> {
  try {
    return normalizeEnvironmentLabel(await NodeFSP.readFile(environmentLabelPath(baseDir), "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

export async function writeEnvironmentLabel(baseDir: string, label: string): Promise<string> {
  const normalized = normalizeEnvironmentLabel(label);
  await atomicWrite(environmentLabelPath(baseDir), `${normalized}\n`);
  return normalized;
}

export async function clearEnvironmentLabel(baseDir: string): Promise<void> {
  await NodeFSP.rm(environmentLabelPath(baseDir), { force: true });
}
