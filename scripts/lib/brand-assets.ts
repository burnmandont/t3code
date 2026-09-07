export const BRAND_ASSET_PATHS = {
  developmentIosIconPng: "assets/dev/sovereign-dev-ios-1024.png",
  developmentDesktopIconPng: "assets/dev/sovereign-dev-macos-1024.png",
  developmentUniversalIconPng: "assets/dev/sovereign-dev-universal-1024.png",
  developmentWindowsIconIco: "assets/dev/sovereign-dev-windows.ico",
  developmentWebFaviconIco: "assets/dev/sovereign-dev-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/sovereign-dev-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/sovereign-dev-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/sovereign-dev-web-apple-touch-180.png",
  developmentMobileIosIconPng: "apps/mobile/assets/branding/development/sovereign-dev-ios-1024.png",
  developmentMobileUniversalIconPng:
    "apps/mobile/assets/branding/development/sovereign-dev-universal-1024.png",

  productionRasterIconDirectory: "assets/prod/sovereign-logo",
  productionMacRasterIconPng: "assets/prod/sovereign-logo/macos-1024.png",
  productionIosIconPng: "assets/prod/sovereign-ios-1024.png",
  productionMacIconPng: "assets/prod/sovereign-macos-1024.png",
  productionLinuxIconPng: "assets/prod/sovereign-universal-1024.png",
  productionWindowsIconIco: "assets/prod/sovereign-windows.ico",
  productionWebFaviconIco: "assets/prod/sovereign-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/sovereign-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/sovereign-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/sovereign-web-apple-touch-180.png",
  productionMobileIosIconPng: "apps/mobile/assets/branding/production/sovereign-ios-1024.png",
  productionMobileUniversalIconPng:
    "apps/mobile/assets/branding/production/sovereign-universal-1024.png",

  nightlyIosIconPng: "assets/nightly/sovereign-preview-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/sovereign-preview-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/sovereign-preview-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/sovereign-preview-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/sovereign-preview-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/sovereign-preview-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/sovereign-preview-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/sovereign-preview-web-apple-touch-180.png",
  nightlyMobileIosIconPng: "apps/mobile/assets/branding/preview/sovereign-preview-ios-1024.png",
  nightlyMobileUniversalIconPng:
    "apps/mobile/assets/branding/preview/sovereign-preview-universal-1024.png",

  marketingIconPng: "apps/marketing/public/icon.png",
  mobileMonochromeMarkPng: "apps/mobile/assets/sovereign-mark.png",
  mobileNotificationMarkPng: "apps/mobile/assets/sovereign-notification-icon.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return version.includes("-nightly.") ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);

export const MARKETING_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "production",
  "apps/marketing/public",
);
