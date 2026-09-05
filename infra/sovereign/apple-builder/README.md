# Sovereign Apple builder

This directory contains the workflow to copy into the existing public
`burnmandont/t3-runtime` artifact repository. That repository supplies
ephemeral macOS runners and stores releases, but it does not mirror application
source. Gitea remains canonical; every job fetches and verifies the exact SHA
from `source.moondiner.com`.

Copy `.github/workflows/release-apple.yml` into the GitHub artifact repository's
default branch, enable Actions, and configure:

## Secrets

- `CSC_LINK`: base64-encoded Developer ID Application certificate archive
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`: App Store Connect API private key contents
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `IOS_DEVELOPMENT_CERTIFICATE_P12`: base64-encoded PKCS#12 export of a persistent
  Apple Development identity for the Apple team
- `IOS_DEVELOPMENT_CERTIFICATE_PASSWORD`: password protecting that PKCS#12 export
- `GITEA_CLONE_TOKEN`: Gitea access token with only the `read:repository` scope

## Variables

- `GITEA_CLONE_USERNAME`: username that owns the Gitea access token
- `APPLE_TEAM_ID`: Apple Developer team that owns the production app
- `IOS_BUNDLE_ID`: production App Store bundle ID (`com.moondiner.t3code`)

Sovereign desktop builds use the hosted OAuth flow, not Clerk's native passkey
bridge. They therefore do not need a Clerk relying-party domain, Associated
Domains entitlement, or provisioning profile. The iOS job uses the same hosted
OAuth configuration. It imports one persistent Apple Development identity so
ephemeral runners do not consume Apple's development-certificate quota, then
lets Xcode manage provisioning and distribution through the App Store Connect
API key. That key must have permission to use automatic signing and upload
builds for the app and its extension targets.

The publishing job uses its short-lived GitHub Actions token to create releases
in the same repository. No long-lived release token is stored on GitHub.
The source credential is sent only through Git's non-interactive HTTPS
credential prompt. It is not embedded in the remote URL or printed to logs. A
dedicated Gitea user with read access only to `t3_fork/sovereign` is preferred,
because a Gitea access token can read every repository its owner can read.

In Gitea, the existing `SOVEREIGN_GITHUB_REPOSITORY` variable supplies the
workflow host's `owner/repository` (`burnmandont/t3-runtime` for production).

The existing `SOVEREIGN_GITHUB_TOKEN`, already scoped to publish runtime assets
in that repository, dispatches the workflow. No additional Gitea secret is
required.

Until `SOVEREIGN_GITHUB_REPOSITORY` is set, production deployment skips the
Apple handoff. Once the variable is present, a missing or invalid dispatch token
fails the release rather than silently omitting the desktop and TestFlight
updates.

The GitHub repository stores no application source or source mirror. GitHub's
ephemeral runners receive the source only for the duration of a release job.
The workflow uses GitHub's standard Apple-silicon macOS runner for native arm64,
cross-packaged x64, and iOS artifacts, so this public repository does not
require an always-on Mac or a paid larger-runner allocation. The macOS jobs
allow enough time for Developer ID timestamping, notarization of the full
Electron bundle, and App Store Connect upload; successful builds still finish
as soon as those steps return.

Each Gitea production run dispatches one exact source SHA, desktop version, and
monotonic iOS build number. The iOS job generates a clean native project with
sovereign OAuth and relay endpoints, archives it, verifies the signed archive's
bundle ID and build number, and uploads it directly to App Store Connect. Keep
automatic distribution enabled for the internal TestFlight group if devices
should receive the new build without an operator assigning it manually.
