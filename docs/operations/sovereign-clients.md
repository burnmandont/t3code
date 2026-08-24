# Sovereign client development

Production push-to-release automation is documented separately in
[Sovereign client continuous delivery](./sovereign-client-cd.md).

This runbook launches first-party clients against the self-hosted account,
relay, hosted web, and Connect infrastructure. Client configuration is public
build-time data; account secrets, database credentials, relay signing keys, and
Coolify tokens never belong in a client environment file.

## Configure this checkout

From the repository root:

```bash
cp infra/sovereign/client.env.example .env.local
vp run dev:sovereign:desktop --check
```

Change the copied URLs when deploying under another domain. The check requires
HTTPS endpoints, rejects embedded URL credentials, and fails closed when Clerk
or client OTLP/Axiom configuration is present. `.env.local` and `.t3` are both
ignored by Git.

## Launch the desktop client

```bash
vp run dev:sovereign:desktop
```

The command builds both halves of the Electron client with the same sovereign
configuration and passes an explicit repository-local T3 home to the normal dev
runner. Stop it with `Ctrl+C` in the terminal that launched it.

After signing in, open **Settings → Connections → Remote Environments** and
select the linked environment. Leave **Publish this environment** and
**Publish agent activity** disabled when the desktop should act only as a
client. These publication settings are independent of its ability to connect
to remote environments.

If the remote list is unexpectedly empty, stop and restart the launcher after
changing `.env.local`. Vite and Electron consume these values at build time; an
already-running generic bundle cannot discover a relay added afterward.

## Run the iOS development client

The sovereign iOS build uses the same `.env.local` file. Set an Apple team and
variant-specific bundle identifiers there. Keeping development and production
separate prevents a release archive from silently inheriting the development
App ID:

```ini
T3CODE_APPLE_TEAM_ID=U2TDSUCYT4
T3CODE_IOS_BUNDLE_ID_DEVELOPMENT=com.moondiner.t3code.development
T3CODE_IOS_BUNDLE_ID_PRODUCTION=com.moondiner.t3code
T3CODE_IOS_BUILD_NUMBER=1
T3CODE_ANDROID_PACKAGE_DEVELOPMENT=com.moondiner.t3code.development
T3CODE_ANDROID_PACKAGE_PRODUCTION=com.moondiner.t3code
```

Increment `T3CODE_IOS_BUILD_NUMBER` before every App Store Connect upload.
The legacy unscoped `T3CODE_IOS_BUNDLE_ID` remains accepted only for local
development builds; preview and production builds fail closed without their
variant-specific identifiers.
Android defaults to the matching iOS identifier; the scoped Android values
allow an explicit Play package namespace without falling back to the upstream
`com.t3tools.t3code` identity.

Install Xcode and CocoaPods, boot an iOS simulator, and then run from
`apps/mobile`:

```bash
EXPO_NO_TELEMETRY=1 \
APP_VARIANT=development \
EXPO_NO_GIT_STATUS=1 \
./node_modules/.bin/expo run:ios
```

`EXPO_NO_TELEMETRY=1` disables Expo CLI telemetry. A sovereign native project
does not install Clerk's config plugin or native SDK, does not contain the
upstream EAS project or owner, and disables Expo updates unless
`T3CODE_EXPO_UPDATES_URL` is explicitly configured. Keep that update variable
unset while updates are manual.

If Expo builds and installs the app but macOS denies its final System Events
check, open Simulator yourself and start Metro from `apps/mobile`:

```bash
EXPO_NO_TELEMETRY=1 \
APP_VARIANT=development \
EXPO_NO_GIT_STATUS=1 \
./node_modules/.bin/expo start --dev-client --lan
```

Use `--lan`, not `--localhost`; the iOS simulator cannot reliably reach Metro
through the Mac loopback address.

Open **Sovereign Dev** in the simulator and accept iOS's one-time development
client prompt. In the app, open **Settings → Account**, continue to the
self-hosted account service, and sign in. The callback returns to
`sovereign-dev://app/connect/account/callback`; the account service must allow that
exact redirect URI.

After sign-in, open **Environments**, select the relay-managed environment, and
verify that its projects and agent sessions are usable. The iOS client consumes
an environment; it does not publish the simulator as a remote environment.

## Test the iOS Release runtime without Metro

Use this before testing a physical phone. It builds the development-branded app
with Xcode's `Release` configuration, embeds the Hermes JavaScript bundle, and
proves that the client can launch without Metro or the Expo development shell.
It is a production-like simulator check, not an App Store archive.

From `apps/mobile`, regenerate the ignored native project and build the ARM64
simulator artifact:

```bash
EXPO_NO_TELEMETRY=1 \
APP_VARIANT=development \
EXPO_NO_GIT_STATUS=1 \
./node_modules/.bin/expo prebuild --clean --platform ios

SIMULATOR_UDID="$(
  xcrun simctl list devices booted -j |
    /usr/bin/python3 -c \
      'import json,sys; print(next(d["udid"] for ds in json.load(sys.stdin)["devices"].values() for d in ds if d["state"] == "Booted"))'
)"

EXPO_NO_TELEMETRY=1 \
APP_VARIANT=development \
EXPO_NO_GIT_STATUS=1 \
xcodebuild \
  -workspace ios/SovereignDev.xcworkspace \
  -scheme SovereignDev \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "id=$SIMULATOR_UDID" \
  -derivedDataPath /tmp/t3-sovereign-release \
  ONLY_ACTIVE_ARCH=YES \
  ARCHS=arm64 \
  build

xcrun simctl install \
  "$SIMULATOR_UDID" \
  /tmp/t3-sovereign-release/Build/Products/Release-iphonesimulator/SovereignDev.app

xcrun simctl launch \
  "$SIMULATOR_UDID" \
  com.moondiner.t3code.development
```

`ARCHS=arm64` matches Apple Silicon simulators and physical iPhones. The custom
terminal module currently does not compile for the legacy Intel simulator
slice, so a universal ARM64 + x86_64 simulator build is not a supported gate.

The built app must contain `main.jsbundle`, must open directly into Sovereign with
no development launcher or floating Expo controls, and must retain the
self-hosted session across terminate-and-relaunch. `Expo.plist` may still be
present because the Expo Updates library is linked, but `EXUpdatesEnabled` must
be `false` unless a sovereign update channel has been deliberately configured.

## Install the Release runtime on a physical iPhone

The first development installation should use USB. Unlock the phone, enable
Developer Mode, trust the Mac, and wait for Xcode to finish preparing developer
support. Confirm that the phone appears as an iOS destination:

```bash
EXPO_NO_TELEMETRY=1 \
APP_VARIANT=development \
EXPO_NO_GIT_STATUS=1 \
xcodebuild \
  -workspace ios/SovereignDev.xcworkspace \
  -scheme SovereignDev \
  -showdestinations
```

Copy the physical iOS destination identifier from that output and build from
`apps/mobile`:

```bash
DEVICE_UDID='<physical-ios-destination-id>'

EXPO_NO_TELEMETRY=1 \
APP_VARIANT=development \
EXPO_NO_GIT_STATUS=1 \
xcodebuild \
  -workspace ios/SovereignDev.xcworkspace \
  -scheme SovereignDev \
  -configuration Release \
  -sdk iphoneos \
  -destination "id=$DEVICE_UDID" \
  -derivedDataPath /tmp/t3-sovereign-device \
  -allowProvisioningUpdates \
  build
```

Find the CoreDevice identifier with `xcrun devicectl list devices`, then install
and launch the signed artifact:

```bash
CORE_DEVICE_ID='<core-device-identifier>'

xcrun devicectl device install app \
  --device "$CORE_DEVICE_ID" \
  /tmp/t3-sovereign-device/Build/Products/Release-iphoneos/SovereignDev.app

xcrun devicectl device process launch \
  --device "$CORE_DEVICE_ID" \
  --terminate-existing \
  com.moondiner.t3code.development
```

After the first USB installation enables developer disk-image services, later
development installs can normally use the paired local-network connection.
Wireless deployment is only an Xcode development convenience: the installed
client's normal OAuth, relay, and remote-environment traffic always uses the
configured HTTPS infrastructure and does not depend on the Mac or a cable.

On the phone, verify self-hosted sign-in, discovery of the relay-managed
environment, project and thread loading, and a terminate-and-relaunch. The
client must not show the Expo development launcher or require Metro.

## Safety boundaries

- The launcher never uses `~/.t3/userdata`; its state is under this checkout's
  `.t3/userdata`.
- The template contains no secrets.
- The launcher does not publish the desktop environment.
- The launcher does not configure telemetry or a third-party identity service.
- Connecting to a relay-managed environment does not expose a local listener or
  require enabling either publication toggle.
- Mobile OAuth tokens are stored in the iOS Keychain through Expo Secure Store;
  the app uses PKCE and refreshes the short-lived relay access token as needed.
