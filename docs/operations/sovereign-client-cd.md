# Sovereign client continuous delivery

This runbook covers the production release lane triggered by a push to
`sovereign-direct`. It deliberately separates **publishing a verified build**
from **interrupting a running remote environment**.

## Release graph

One green production workflow performs these operations in order:

1. The Linux runner typechecks and tests the sovereign closures.
2. It builds and deploys `t3-observability`, `t3-control`, and `t3-web` from
   the exact production commit.
3. It signs and publishes the exact commit-addressed Linux remote runtime to
   Gitea and the public GitHub artifact repository.

The browser receives the deployed web build immediately. After the deployment
passes, Gitea dispatches the verified commit SHA, derived desktop version, and
derived iOS build number to the public GitHub artifact repository. Ephemeral
GitHub-hosted macOS runners fetch that exact SHA directly from Gitea, build both
macOS architectures, sign and notarize them, and publish the desktop updater
release. A separate macOS runner generates the production iOS project from the
same SHA, signs and archives it, verifies the bundle ID and derived build
number, and uploads it to App Store Connect.

The signed remote runtime is published automatically. Exact build drift offers
an explicit server sync action even when the client and server protocols remain
compatible; protocol drift changes that offer into a compatibility warning.
Activation remains explicit. A blind timer would restart agent harnesses in
the middle of work; automatic remote activation is deferred until the server
can prove it is idle and preserve the existing trial/rollback protocol.

Expo OTA is not part of this release boundary unless an operator-owned
`T3CODE_EXPO_UPDATES_URL` is configured. With that variable blank, every mobile
change is a signed TestFlight binary and no Expo-hosted update service is used.

## Coordinated identity

Each client embeds the commit-addressed server build identity alongside the
separate client/server protocol identity. Apple releases use store-compatible,
monotonically increasing client identifiers:

- desktop version: `major.minor.(patch × 100000 + run number)`;
- iOS build number: `100000 + run number`.

The desktop release tag is `desktop-v<derived version>`. Runtime GitHub
releases are never marked `latest`; the `latest` pointer is reserved for a
complete desktop updater release containing the DMG, ZIP, blockmaps, and
`latest-mac.yml`. Assets are immutable: an existing asset may be reused only
when its bytes are identical.

## Apple client releases

Gitea remains the canonical and only persistent application source repository.
The public GitHub artifact repository stores the workflow in
`infra/sovereign/apple-builder`; it does not mirror application source. Its
Apple signing material is scoped to that repository, and its publishing job
uses a short-lived Actions token. The ephemeral runner verifies the fetched SHA
before executing source-owned build code and validates the notarized DMG before
publishing it.

Sovereign mobile binaries do not depend on the upstream EAS production lane.
The GitHub builder uploads each production SHA directly to App Store Connect
with Xcode. The iOS lane and both desktop architectures run independently after
the shared configuration gate, so the overall Apple workflow is not green
unless every requested client build succeeds.

## App Store Connect

The existing production record is App Store Connect app `6800047022` with
bundle ID `com.moondiner.t3code`. Keep distribution private through an internal
TestFlight group. Enable automatic distribution of new builds to that group;
do not submit for public App Review. App Store Connect processing and group
distribution happen after GitHub's upload completes, so they may lag the green
build job by several minutes.

TestFlight builds expire after 90 days. Continuous delivery keeps a fresh
build available but is not a permanent private distribution mechanism by
itself. A future move away from TestFlight requires another Apple-approved
distribution model, not an Expo dependency.

## Manual release verification

For each Apple release, verify the embedded build and protocol identities,
signing and notarization, desktop updater assets, and a clean launch of the
installed app. For iOS, also verify App Store Connect processing, TestFlight
installation, sign-in, remote environments, threads, APNs, and Live Activity
cleanup.

## Rollback

- Hosted services: redeploy the prior known-good commit through the existing
  Coolify path.
- Desktop: publish a new, higher derived version containing the reverted code;
  updater clients do not accept a lower version as a normal rollback.
- iOS: upload a new, higher build number from the reverted commit and assign it
  to the internal TestFlight group.
- Remote runtime: retain the exact signed-version operator recovery command in
  the runtime runbook. Do not move an immutable tag or replace release bytes.

Every rollback is forward-moving in its platform's version space and remains
traceable to a source commit.
