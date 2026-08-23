import type { ExpoConfig } from "expo/config";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const sovereignOAuthValues = {
  issuer: repoEnv.T3CODE_OAUTH_ISSUER?.trim(),
  clientId: repoEnv.T3CODE_OAUTH_CLIENT_ID?.trim(),
  resource: repoEnv.T3CODE_OAUTH_RESOURCE?.trim(),
  relayUrl: repoEnv.T3CODE_RELAY_URL?.trim(),
};
const sovereignOAuthValueCount = Object.values(sovereignOAuthValues).filter(Boolean).length;
if (sovereignOAuthValueCount > 0 && sovereignOAuthValueCount < 4) {
  throw new Error(
    "Sovereign mobile builds require T3CODE_OAUTH_ISSUER, T3CODE_OAUTH_CLIENT_ID, T3CODE_OAUTH_RESOURCE, and T3CODE_RELAY_URL together.",
  );
}
const isSovereignBuild = sovereignOAuthValueCount === 4;

const sovereignIosBundleIdentifier =
  APP_VARIANT === "development"
    ? (repoEnv.T3CODE_IOS_BUNDLE_ID_DEVELOPMENT?.trim() ??
      // Backward compatibility for existing local development checkouts. Do
      // not use the unscoped value for preview or production: doing so could
      // silently sign a release artifact with the development App ID.
      repoEnv.T3CODE_IOS_BUNDLE_ID?.trim())
    : APP_VARIANT === "preview"
      ? repoEnv.T3CODE_IOS_BUNDLE_ID_PREVIEW?.trim()
      : repoEnv.T3CODE_IOS_BUNDLE_ID_PRODUCTION?.trim();
const iosBuildNumber = repoEnv.T3CODE_IOS_BUILD_NUMBER?.trim() ?? "1";

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

if (
  isSovereignBuild &&
  (!sovereignIosBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(sovereignIosBundleIdentifier))
) {
  throw new Error(
    `T3CODE_IOS_BUNDLE_ID_${APP_VARIANT.toUpperCase()} must be a reverse-DNS identifier for sovereign ${APP_VARIANT} builds.`,
  );
}

if (!/^\d+$/.test(iosBuildNumber) || Number(iosBuildNumber) < 1) {
  throw new Error("T3CODE_IOS_BUILD_NUMBER must be a positive integer.");
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.developmentUniversalIconPng),
  androidAdaptiveBackgroundColor: "#00639B",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.nightlyLinuxIconPng),
  androidAdaptiveBackgroundColor: "#111533",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground: fromRepoRoot(BRAND_ASSET_PATHS.productionLinuxIconPng),
  androidAdaptiveBackgroundColor: "#000000",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "Sovereign Dev",
    scheme: "t3code-dev",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.t3tools.t3code.dev",
    relyingParty: "clerk.t3.codes",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "Sovereign Preview",
    scheme: "t3code-preview",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.t3tools.t3code.preview",
    relyingParty: "clerk.t3.codes",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "Sovereign",
    scheme: "t3code",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.t3tools.t3code",
    relyingParty: "clerk.t3.codes",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : isSovereignBuild
    ? sovereignIosBundleIdentifier!
    : variant.iosBundleIdentifier;
const sovereignUpdatesUrl = repoEnv.T3CODE_EXPO_UPDATES_URL?.trim();
const appUpdatesEnabled = !isSovereignBuild || Boolean(sovereignUpdatesUrl);

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Agent activity can update many times an hour; without the
    // frequent-updates entitlement iOS throttles the update budget sooner.
    frequentUpdates: true,
    widgets: [
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active Sovereign agents.",
        supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets. Keep the
      // reduced-capability local build usable while release builds expose the
      // real system share target.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["text/plain", "image/*"],
      multipleShareMimeTypes: ["image/*"],
    },
  },
];

const clerkPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "@clerk/expo",
  { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild },
];

type ExpoPlugin = NonNullable<ExpoConfig["plugins"]>[number];

// Explicitly type conditional plugin groups before spreading them. Without
// this boundary TypeScript widens two-element plugin tuples into arbitrary
// arrays and ExpoConfig can no longer prove that each entry is a valid plugin.
const sharingPlugins: ReadonlyArray<ExpoPlugin> = isIosPersonalTeamBuild
  ? [sharingPlugin]
  : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin];
const identityPlugins: ReadonlyArray<ExpoPlugin> = !isSovereignBuild ? [clerkPlugin] : [];
const widgetPlugins: ReadonlyArray<ExpoPlugin> = !isIosPersonalTeamBuild
  ? [
      [
        "./plugins/withIosApsEnvironment.cjs",
        { environment: APP_VARIANT === "development" ? "development" : "production" },
      ],
      "./plugins/withWidgetLogoAsset.cjs",
      widgetsPlugin,
    ]
  : [];
const personalTeamPlugins: ReadonlyArray<ExpoPlugin> = isIosPersonalTeamBuild
  ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"]
  : [];

// These aliases match the fonts' PostScript names on iOS. Register the same
// names on Android so React Native and the native composer use one set of
// family names without waiting for runtime font loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: "t3-code",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "1.0.4",
  runtimeVersion: {
    // Fingerprint (not appVersion) so an OTA only reaches binaries whose native
    // project — native deps, config plugins, AND patches/ — matches the update.
    // With appVersion, every 0.1.0 build shares a runtime version, so a JS update
    // could land on a binary missing the native changes it needs and crash.
    policy: process.env.MOBILE_VERSION_POLICY ?? "fingerprint",
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: appUpdatesEnabled,
    ...(!isSovereignBuild || sovereignUpdatesUrl
      ? { url: sovereignUpdatesUrl ?? "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454" }
      : {}),
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    buildNumber: iosBuildNumber,
    entitlements: {
      // Distribution builds must register against production APNs. Declare
      // this at the app-config boundary because another native plugin may
      // create the entitlement before expo-notifications runs, in which case
      // that plugin deliberately preserves the existing value.
      "aps-environment": APP_VARIANT === "development" ? "development" : "production",
    },
    // Multitasking-capable iPad apps cannot rotate programmatically, so the
    // showcase capture build requires full screen (see infoPlist below).
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    // Pin code signing to the T3 Tools team so non-interactive `expo run:ios`
    // does not fall back to a personal team (which cannot sign app groups,
    // Sign in with Apple, or push notification entitlements).
    appleTeamId: isSovereignBuild ? repoEnv.T3CODE_APPLE_TEAM_ID?.trim() : "ARK85ZXQ4Z",
    associatedDomains: isSovereignBuild
      ? []
      : [`applinks:${variant.relyingParty}`, `webcredentials:${variant.relyingParty}`],
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Sovereign to connect to Sovereign servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
      // The App Store screenshot harness rotates the iPad interface from
      // inside the app (CI denies osascript the Accessibility access that
      // Simulator menu scripting needs), and iPadOS ignores programmatic
      // orientation requests for multitasking-capable apps — so the capture
      // build opts out of multitasking and declares landscape support.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      foregroundImage: variant.assets.androidAdaptiveForeground,
      ...("androidMonochromeIcon" in variant.assets
        ? { monochromeImage: variant.assets.androidMonochromeIcon }
        : {}),
    },
    // Opts into OnBackInvokedCallback-based back dispatch (Android 13+).
    // JS back handling survives it via react-native's Android 16 shim plus
    // withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    "expo-asset",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...sharingPlugins,
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    // Sovereign clients use first-party browser OAuth and must not install
    // Clerk's native identity configuration.
    ...identityPlugins,
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        // Adaptive launcher-shortcut icon; referenced by resource name from
        // the shortcut items set in src/features/shortcuts.
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
          },
        },
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow Sovereign to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#0a0a0a",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "18.0",
          ...(!isSovereignBuild
            ? {
                // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
                extraPods: [
                  { name: "GoogleUtilities", modular_headers: true },
                  { name: "RecaptchaInterop", modular_headers: true },
                ],
              }
            : {}),
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Must be listed BEFORE expo-widgets: same-type mods run last-registered-
    // first, so registering earlier makes this plugin's mods run AFTER
    // expo-widgets' — its dangerous mod wipes ios/ExpoWidgetsTarget/ (which
    // would delete the asset catalog) and its xcodeproj mod creates the widget
    // target (which must exist before the compile phase can be attached).
    ...widgetPlugins,
    "./plugins/withIosSceneLifecycle.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    ...personalTeamPlugins,
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    oauth: {
      issuer: sovereignOAuthValues.issuer ?? null,
      clientId: sovereignOAuthValues.clientId ?? null,
      resource: sovereignOAuthValues.resource ?? null,
      redirectScheme: isSovereignBuild ? variant.scheme : null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Native Google sign-in credentials. @clerk/expo reads these from `extra`
    // under their exact env-var names (not nested), and its config plugin reads
    // the iOS URL scheme at prebuild to register it in Info.plist.
    // Unset values must be omitted (not null): the public manifest serializes
    // null to {}, which is truthy and would defeat Clerk's fallback checks.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? null,
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    appUpdates: {
      // Expo Dev Client can report its native update module as enabled even
      // when this build deliberately has no OTA channel. Mirror the manifest
      // policy into public runtime config so launch and manual checks fail
      // closed instead of invoking an unconfigured updater.
      enabled: appUpdatesEnabled,
    },
    ...(!isSovereignBuild
      ? {
          eas: {
            projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
          },
        }
      : {}),
  },
  ...(!isSovereignBuild ? { owner: "pingdotgg" } : {}),
};

export default config;
