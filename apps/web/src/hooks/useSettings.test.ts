import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  resolveSettingsEnvironmentId,
} from "./useSettings";

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });

  it("keeps server settlement settings when legacy client data contains retired keys", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 14,
      sidebarAutoSettleOnMerge: false,
    };
    const legacyClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 1,
      sidebarAutoSettleOnMerge: true,
    };

    const settings = mergeEnvironmentSettings(serverSettings, legacyClientSettings);

    expect(settings.sidebarAutoSettleAfterDays).toBe(14);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});

describe("resolveSettingsEnvironmentId", () => {
  const primary = EnvironmentId.make("primary");
  const active = EnvironmentId.make("active");
  const remote = EnvironmentId.make("remote");

  it("prefers the primary environment when one exists", () => {
    expect(
      resolveSettingsEnvironmentId({
        primaryEnvironmentId: primary,
        activeEnvironmentId: active,
        environmentIds: [primary, active],
      }),
    ).toBe(primary);
  });

  it("uses the active remote environment in hosted mode", () => {
    expect(
      resolveSettingsEnvironmentId({
        primaryEnvironmentId: null,
        activeEnvironmentId: active,
        environmentIds: [remote, active],
      }),
    ).toBe(active);
  });

  it("uses the sole remote environment when no environment is active", () => {
    expect(
      resolveSettingsEnvironmentId({
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
        environmentIds: [remote],
      }),
    ).toBe(remote);
  });

  it("does not choose arbitrarily between multiple inactive remotes", () => {
    expect(
      resolveSettingsEnvironmentId({
        primaryEnvironmentId: null,
        activeEnvironmentId: null,
        environmentIds: [remote, active],
      }),
    ).toBeNull();
  });
});
