import {
  CLIENT_SERVER_PROTOCOL_VERSION,
  type EnvironmentId,
  type ServerConfig,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

import { APP_VERSION, TARGET_SERVER_RUNTIME_ID } from "./branding";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export interface VersionMismatch {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly hint: string;
}

export interface ServerRuntimeDrift {
  readonly clientVersion: string;
  readonly serverVersion: string;
}

export interface ServerRuntimeIdentityComparison {
  readonly serverRuntimeId?: string | null;
  readonly targetServerRuntimeId?: string | null;
}

export const VERSION_MISMATCH_DISMISSALS_STORAGE_KEY = "t3code:version-mismatch-dismissals:v1";

// Runtime failures retain their identity until the next attempt. Dismiss only
// that attempt, across chat remounts, without clearing the error in Settings.
const dismissedServerUpdateFailures = new WeakSet<ServerUpdateState>();

export function isServerUpdateFailureDismissed(state: ServerUpdateState): boolean {
  return state.status === "failed" && dismissedServerUpdateFailures.has(state);
}

export function dismissServerUpdateFailure(state: ServerUpdateState): void {
  if (state.status === "failed") dismissedServerUpdateFailures.add(state);
}

const VersionMismatchDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type VersionMismatchDismissals = typeof VersionMismatchDismissalsSchema.Type;

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function releaseLine(version: string): string | null {
  return /^(\d+\.\d+\.\d+)(?:[-+].*)?$/u.exec(version)?.[1] ?? null;
}

function legacyVersionsAreCompatible(clientVersion: string, serverVersion: string): boolean {
  if (!clientVersion.includes("+sovereign.") && !serverVersion.includes("+sovereign.")) {
    return false;
  }
  const clientReleaseLine = releaseLine(clientVersion);
  return clientReleaseLine !== null && clientReleaseLine === releaseLine(serverVersion);
}

/** Core `major.minor.patch`, dropping any prerelease or build suffix. */
function versionCore(version: string): string {
  return version.replace(/[-+].*$/, "");
}

/**
 * The skew a user can act on: the connected server runs an older Sovereign version than
 * this client, so the server is the side that needs updating.
 *
 * Two nightly builds compare their full versions, including the date and run.
 * Other combinations compare their core `major.minor.patch` only, so a stable
 * build and a nightly build with the same core do not cause an update warning.
 * A server ahead of the client does not need an update. Versions that do not
 * parse as semver fall back to plain string inequality.
 */
export function resolveVersionMismatch(
  serverVersion: string | null | undefined,
  serverProtocolVersion?: number | null | undefined,
): VersionMismatch | null {
  const normalizedClientVersion = normalizeVersion(APP_VERSION);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  if (!normalizedClientVersion || !normalizedServerVersion) {
    return null;
  }

  if (serverProtocolVersion === CLIENT_SERVER_PROTOCOL_VERSION) {
    return null;
  }
  if (serverProtocolVersion !== null && serverProtocolVersion !== undefined) {
    return {
      clientVersion: normalizedClientVersion,
      serverVersion: normalizedServerVersion,
      hint: "Version mismatch. Try syncing the client and server to the same Sovereign version.",
    };
  }
  // Protocol 1 shipped after commit-addressed sovereign versions. Those
  // immediately preceding servers are compatible when their release line
  // matches; once the protocol advances, absence must mean incompatible.
  if (
    CLIENT_SERVER_PROTOCOL_VERSION === 1 &&
    legacyVersionsAreCompatible(normalizedClientVersion, normalizedServerVersion)
  ) {
    return null;
  }

  const clientCore = versionCore(normalizedClientVersion);
  const serverCore = versionCore(normalizedServerVersion);
  const compareNightlyBuilds =
    parseSemver(normalizedClientVersion)?.prerelease[0] === "nightly" &&
    parseSemver(normalizedServerVersion)?.prerelease[0] === "nightly";
  const serverIsBehind =
    parseSemver(clientCore) && parseSemver(serverCore)
      ? compareSemverVersions(
          compareNightlyBuilds ? normalizedServerVersion : serverCore,
          compareNightlyBuilds ? normalizedClientVersion : clientCore,
        ) < 0
      : normalizedServerVersion !== normalizedClientVersion;
  if (!serverIsBehind) {
    return null;
  }

  return {
    clientVersion: normalizedClientVersion,
    serverVersion: normalizedServerVersion,
    hint: "Version mismatch. Try syncing the client and server to the same Sovereign version.",
  };
}

export function resolveServerConfigVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): VersionMismatch | null {
  return resolveVersionMismatch(
    serverConfig?.environment.serverVersion,
    serverConfig?.environment.clientServerProtocolVersion,
  );
}

/** Exact runtime identity is independent from wire compatibility. Compatible
    servers can still be missing server-side fixes from the client's build. */
export function resolveServerRuntimeDrift(
  serverVersion: string | null | undefined,
  identity: ServerRuntimeIdentityComparison = {},
): ServerRuntimeDrift | null {
  const normalizedClientVersion = normalizeVersion(APP_VERSION);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  const normalizedServerRuntimeId = normalizeVersion(identity.serverRuntimeId);
  const normalizedTargetServerRuntimeId = normalizeVersion(identity.targetServerRuntimeId);
  const hasComparableRuntimeIds =
    normalizedServerRuntimeId !== null && normalizedTargetServerRuntimeId !== null;
  if (
    !normalizedClientVersion ||
    !normalizedServerVersion ||
    (hasComparableRuntimeIds
      ? normalizedServerRuntimeId === normalizedTargetServerRuntimeId
      : normalizedClientVersion === normalizedServerVersion)
  ) {
    return null;
  }
  return {
    clientVersion: normalizedClientVersion,
    serverVersion: normalizedServerVersion,
  };
}

export function resolveServerConfigRuntimeDrift(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
  targetServerRuntimeId: string | null = TARGET_SERVER_RUNTIME_ID,
): ServerRuntimeDrift | null {
  const serverRuntimeId = serverConfig?.environment.serverRuntimeId;
  return resolveServerRuntimeDrift(serverConfig?.environment.serverVersion, {
    ...(serverRuntimeId === undefined ? {} : { serverRuntimeId }),
    ...(targetServerRuntimeId === null ? {} : { targetServerRuntimeId }),
  });
}

/** The update path the connected server offers, or null when it only
    supports a manual relaunch (older servers, dev checkouts, Windows). */
export function resolveServerSelfUpdateCapability(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): ServerSelfUpdateCapability | null {
  return serverConfig?.environment.capabilities.serverSelfUpdate ?? null;
}

/** True when the desktop app supervising this server can be told to update
    itself over RPC. Older desktop servers only get the manual instruction. */
export function supportsDesktopAppUpdate(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.desktopAppUpdate === true;
}

/** True when the connected server can recover opted-in running turns after
    its self-update restart. */
export function supportsServerUpdateThreadContinuation(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.serverUpdateThreadContinuation === true;
}

/** The command to hand users whose server cannot update itself. */
export function manualServerUpdateCommand(targetVersion: string): string {
  if (/^\d+\.\d+\.\d+\+sovereign\.g[a-f0-9]{7,64}$/u.test(targetVersion)) {
    return `curl -fsSL https://get.moondiner.com/install | sh -s -- serve --version ${targetVersion}`;
  }
  return `npx t3@${targetVersion}`;
}

export function serverUpdateGuidance(capability: ServerSelfUpdateCapability): string {
  return capability === "desktop-managed" ? "Update the desktop app" : "Update to stay in sync";
}

export function buildVersionMismatchDismissalKey(
  environmentId: EnvironmentId,
  mismatch: Pick<VersionMismatch, "clientVersion" | "serverVersion">,
): string {
  return `${environmentId}:${mismatch.clientVersion}:${mismatch.serverVersion}`;
}

function readVersionMismatchDismissals(): VersionMismatchDismissals {
  try {
    return (
      getLocalStorageItem(
        VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
        VersionMismatchDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch (error) {
    console.error("Could not read version-mismatch dismissals.", error);
    return { keys: [] };
  }
}

function writeVersionMismatchDismissals(document: VersionMismatchDismissals): void {
  try {
    setLocalStorageItem(
      VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
      document,
      VersionMismatchDismissalsSchema,
    );
  } catch (error) {
    console.error("Could not persist version-mismatch dismissals.", error);
  }
}

export function isVersionMismatchDismissed(dismissalKey: string | null | undefined): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readVersionMismatchDismissals().keys.includes(dismissalKey);
}

export function dismissVersionMismatch(dismissalKey: string | null | undefined): void {
  if (!dismissalKey) {
    return;
  }
  const document = readVersionMismatchDismissals();
  if (document.keys.includes(dismissalKey)) {
    return;
  }
  writeVersionMismatchDismissals({
    keys: [...document.keys, dismissalKey],
  });
}
