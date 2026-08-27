import { CLIENT_SERVER_PROTOCOL_VERSION, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_VERSION } from "./branding";
import {
  appendVersionMismatchHint,
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerConfigRuntimeDrift,
  resolveServerSelfUpdateCapability,
  resolveServerRuntimeDrift,
  resolveVersionMismatch,
  manualServerUpdateCommand,
  serverUpdateGuidance,
} from "./versionSkew";

describe("versionSkew", () => {
  it("does not warn when versions match", () => {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull();
  });

  it("returns a mismatch when a legacy server is on a different release line", () => {
    expect(resolveVersionMismatch("9.9.9")).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
      hint: "Version mismatch. Try syncing the client and server to the same Sovereign version.",
    });
  });

  it("does not warn when exact sovereign builds share the current protocol", () => {
    expect(
      resolveVersionMismatch("9.9.9+sovereign.gabcdef012345", CLIENT_SERVER_PROTOCOL_VERSION),
    ).toBeNull();
  });

  it("detects exact runtime drift even when the server protocol is compatible", () => {
    const serverVersion = "9.9.9+sovereign.gabcdef012345";

    expect(resolveVersionMismatch(serverVersion, CLIENT_SERVER_PROTOCOL_VERSION)).toBeNull();
    expect(resolveServerRuntimeDrift(serverVersion)).toEqual({
      clientVersion: APP_VERSION,
      serverVersion,
    });
  });

  it("ignores client-only release drift when the server runtime identity matches", () => {
    const serverVersion = "9.9.9+sovereign.gpreviousclient";

    expect(
      resolveServerRuntimeDrift(serverVersion, {
        serverRuntimeId: "sha256:unchanged-server-closure",
        targetServerRuntimeId: "sha256:unchanged-server-closure",
      }),
    ).toBeNull();
  });

  it("reports drift when runtime identities differ even if release versions match", () => {
    expect(
      resolveServerRuntimeDrift(APP_VERSION, {
        serverRuntimeId: "sha256:previous-server-closure",
        targetServerRuntimeId: "sha256:current-server-closure",
      }),
    ).toEqual({ clientVersion: APP_VERSION, serverVersion: APP_VERSION });
  });

  it("falls back to release versions until both runtime identities are available", () => {
    expect(
      resolveServerRuntimeDrift(APP_VERSION, {
        serverRuntimeId: "sha256:server-closure",
      }),
    ).toBeNull();
  });

  it("does not report runtime drift when exact builds match", () => {
    expect(resolveServerRuntimeDrift(APP_VERSION)).toBeNull();
  });

  it("warns when the server reports an incompatible protocol", () => {
    expect(resolveVersionMismatch("9.9.9", CLIENT_SERVER_PROTOCOL_VERSION + 1)).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
      hint: "Version mismatch. Try syncing the client and server to the same Sovereign version.",
    });
  });

  it("trusts an explicit protocol mismatch over equal build versions", () => {
    expect(resolveVersionMismatch(APP_VERSION, CLIENT_SERVER_PROTOCOL_VERSION + 1)).toMatchObject({
      clientVersion: APP_VERSION,
      serverVersion: APP_VERSION,
    });
  });

  it("treats legacy sovereign builds on the same release line as compatible", () => {
    const clientReleaseLine = APP_VERSION.split(/[+-]/u, 1)[0];
    expect(resolveVersionMismatch(`${clientReleaseLine}+sovereign.gabcdef012345`)).toBeNull();
  });

  it("keeps strict fallback behavior for malformed legacy versions", () => {
    expect(resolveVersionMismatch("development-build")).toMatchObject({
      serverVersion: "development-build",
    });
  });

  it("reads the server version from config descriptors", () => {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-1"),
          label: "Remote",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "9.9.9",
          clientServerProtocolVersion: CLIENT_SERVER_PROTOCOL_VERSION + 1,
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toMatchObject({
      serverVersion: "9.9.9",
    });
  });

  it("reads exact runtime drift from config descriptors", () => {
    expect(
      resolveServerConfigRuntimeDrift({
        environment: {
          environmentId: EnvironmentId.make("environment-runtime-drift"),
          label: "Remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "9.9.9+sovereign.gabcdef012345",
          clientServerProtocolVersion: CLIENT_SERVER_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        },
      }),
    ).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9+sovereign.gabcdef012345",
    });
  });

  it("uses descriptor runtime identity instead of a client-only release version", () => {
    expect(
      resolveServerConfigRuntimeDrift(
        {
          environment: {
            environmentId: EnvironmentId.make("environment-client-only-release"),
            label: "Remote",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "9.9.9+sovereign.gpreviousclient",
            serverRuntimeId: "sha256:unchanged-server-closure",
            clientServerProtocolVersion: CLIENT_SERVER_PROTOCOL_VERSION,
            capabilities: { repositoryIdentity: true },
          },
        },
        "sha256:unchanged-server-closure",
      ),
    ).toBeNull();
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(key).toBe(`${environmentId}:${APP_VERSION}:9.9.9`);
    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });

  it("appends a hint to connection errors when versions differ", () => {
    const mismatch = resolveVersionMismatch("9.9.9");

    expect(appendVersionMismatchHint("Socket closed.", mismatch)).toBe(
      "Socket closed. Hint: Version mismatch. Try syncing the client and server to the same Sovereign version.",
    );
  });

  it("reads desktop-managed update capabilities from config descriptors", () => {
    expect(
      resolveServerSelfUpdateCapability({
        environment: {
          environmentId: EnvironmentId.make("environment-desktop"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: "desktop-managed",
          },
        },
      }),
    ).toBe("desktop-managed");
    expect(resolveServerSelfUpdateCapability(null)).toBeNull();
  });

  it("matches version-drift guidance to the advertised update path", () => {
    expect(serverUpdateGuidance("respawn", "Remote server")).toBe(
      "Update the Remote server so they stay in sync.",
    );
    expect(serverUpdateGuidance("desktop-managed", "Desktop server")).toBe(
      "Update the desktop app that runs the Desktop server.",
    );
    expect(serverUpdateGuidance(null, "Local server")).toBe(
      "Relaunch the Local server with the copied command to sync them.",
    );
  });

  it("uses the signed installer rather than npm for a sovereign runtime", () => {
    expect(manualServerUpdateCommand("0.0.32+sovereign.gabcdef012345")).toBe(
      "curl -fsSL https://get.moondiner.com/install | sh -s -- serve --version 0.0.32+sovereign.gabcdef012345",
    );
    expect(manualServerUpdateCommand("0.0.33")).toBe("npx t3@0.0.33");
  });
});
