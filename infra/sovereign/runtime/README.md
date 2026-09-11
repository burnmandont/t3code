# Sovereign remote runtime artifacts

Remote environments consume a complete, signed runtime from public GitHub
Release assets. Installation traffic never traverses the sovereign edge,
control plane, Gitea, or databases. The private Gitea Generic Package Registry
remains the CI input and archival mirror; remote environments receive no Gitea
credentials. They do not install the sovereign fork from npm, and the runtime
archive already contains the pinned FRP client.

Once the source file exists, installation is deliberately fail-closed. A
missing release, malformed configuration, non-HTTPS redirect, invalid Ed25519
signature, wrong version/platform, size mismatch, or SHA-256 mismatch aborts
the update. None of those failures falls back to npm.

## Public distribution layout

Use one dedicated public GitHub repository containing only generated installer,
channel, and release files. It must not contain the private source fork,
credentials, infrastructure configuration, or signing private key. GitHub
Pages serves:

```text
https://get.moondiner.com/install
https://get.moondiner.com/channels/stable.json
```

Every successful commit produces an exact version such as
`0.0.32+sovereign.gf0df24970d9c` and a GitHub Release named
`runtime-0.0.32+sovereign.gf0df24970d9c` with two assets. The commit identity
is SemVer build metadata, not a prerelease ordering key: Git hashes are opaque
identifiers and do not encode release chronology.

```text
<version>/linux-x64.manifest.json
<version>/t3-sovereign-runtime-linux-x64.tar.gz
<version>/darwin-arm64.manifest.json
<version>/t3-sovereign-runtime-darwin-arm64.tar.gz
```

Each artifact is built on its matching operating system and architecture; do
not cross-compile native Node modules for release. The Darwin archive bundles
FRP's pinned `darwin_arm64` client. A stable channel release is complete only
when both platform manifests and archives have been published.

Both the stable channel and artifact manifest are envelopes containing exact
JSON payloads as base64 and Ed25519 signatures over those exact bytes. The
channel binds `stable` to one commit-addressed version. The manifest binds the
version, platform, architecture, filename, compressed byte size, SHA-256, and
Git commit. GitHub is only a distributor: the installer verifies both signed
documents and the complete archive before extracting or executing it.

## One-time signing setup

Generate the runtime key independently from the relay signing key:

```sh
openssl genpkey -algorithm Ed25519 -out sovereign-runtime-signing.pem

openssl pkey \
  -in sovereign-runtime-signing.pem \
  -outform DER |
base64 | tr -d '\n'

openssl pkey \
  -in sovereign-runtime-signing.pem \
  -pubout \
  -outform DER |
base64 | tr -d '\n'
```

Store the first output as the protected Gitea Actions secret
`SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64`. Store the second in the offline
recovery record and use it as
`SOVEREIGN_RUNTIME_SIGNING_PUBLIC_KEY_B64` on remote environments. Never put
the private key in Coolify, a remote environment, the repository, or a package.

Create a Gitea token with package read/write access for CI's private mirror and
FRP input. Configure the existing Gitea settings:

- Actions variable `SOVEREIGN_PACKAGE_BASE_URL` with the Generic Package root;
- Actions variable `SOVEREIGN_PACKAGE_USERNAME` with the package owner/publisher;
- Actions variable `SOVEREIGN_FRPC_ASSET_URL` with the immutable mirrored asset URL;
- Actions secret `SOVEREIGN_PACKAGE_TOKEN` with the package token;
- Actions secret `SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64` with the key above.

The public distribution repository is `burnmandont/t3-runtime`. Its default
branch is `master`. Enable Pages from the root of `master`, configure
`get.moondiner.com` as its custom domain, and enforce HTTPS. Create a
fine-grained GitHub token restricted to that repository with Contents
read/write access. Configure these Gitea Actions values:

- variable `SOVEREIGN_GITHUB_REPOSITORY` as `burnmandont/t3-runtime`;
- variable `SOVEREIGN_GITHUB_PAGES_ORIGIN` as `https://get.moondiner.com`;
- secret `SOVEREIGN_GITHUB_TOKEN` with the repository-restricted token.

The same public distribution repository runs the versioned
`release-runtime-darwin.yml` Apple-builder workflow. Synchronize that workflow
alongside `release-apple.yml`; it uses only the existing read-only Gitea clone
credential. The macOS runner downloads the pinned, checksum-verified public
Darwin FRPC input and uploads an unsigned native runtime as an Actions artifact.
Gitea downloads it, signs it, and publishes it using the credentials already
held by Gitea CI.

The existing GitHub token used by Gitea must be able to read Actions artifacts,
because Gitea dispatches the exact source SHA and waits for that Darwin workflow
to finish. Stable publication then verifies that both platform archives and
manifests exist before moving the channel.

The workflow uploads the immutable release assets first, publishes the release,
updates the generated installer, and moves the signed stable channel last. A
retry accepts an existing release asset only when its SHA-256 is identical.

The workflow typechecks and tests the server, derives the commit-addressed
version, builds the clients and complete Linux runtime, signs it, archives it
privately in Gitea, publishes it publicly to GitHub, then deploys the control
plane and web app. Publication is blocked unless the packaged CLI contains the
sovereign hosted-app, OAuth issuer, and relay origins; this prevents a clean
machine from silently falling back to the upstream Sovereign account infrastructure.

Before the first workflow, mirror both pinned FRP inputs into Gitea. The expected
destinations are immutable Generic Package files, for example:

```text
https://source.moondiner.com/api/packages/t3_fork/generic/t3-sovereign-third-party/0.70.1/frp_0.70.1_linux_amd64.tar.gz
https://source.moondiner.com/api/packages/t3_fork/generic/t3-sovereign-third-party/0.70.1/frp_0.70.1_darwin_arm64.tar.gz
```

With the package publisher credentials exported, run this once from the
checkout:

```sh
export SOVEREIGN_FRPC_ASSET_URL=https://source.moondiner.com/api/packages/t3_fork/generic/t3-sovereign-third-party/0.70.1/frp_0.70.1_linux_amd64.tar.gz
node infra/sovereign/runtime/mirror-frpc.mjs
```

Run the same command on Apple Silicon with `SOVEREIGN_FRPC_ASSET_URL` set to
the Darwin mirror destination. The script selects and verifies the matching
upstream archive from the host platform.

This one-time command downloads the official release, verifies the hard-coded
SHA-256, and creates or byte-verifies the immutable Gitea copy. Routine CI then
fetches this third-party input only from Gitea rather than GitHub's upstream FRP
release.

## Install a remote without credentials

The normal first-run path is one command on Linux x64 or Apple Silicon macOS:

```sh
curl -fsSL https://get.moondiner.com/install | sh -s -- serve
```

The small installer and large runtime assets are served by GitHub. Before the
verified runtime starts, the installer requires one sovereign control-plane
origin with no public default and fetches its public,
credentialless `/.well-known/t3-sovereign.json` discovery document. That one
origin resolves the matching hosted app, OAuth issuer/client/resource, and
relay; the installer rejects mixed origins, plaintext non-loopback endpoints,
credentials, queries, and fragments. It also asks for this machine's display
label and persists the answer rather than binding relay identity to the
operating-system hostname; that first-run label also has no hostname default.
It requires a supported platform, Node
22.16 or newer, and `tar`, matching the upstream server prerequisite of
an existing Node installation. The shell wrapper stages its embedded module in
a private temporary directory and connects interactive authorization to the
controlling terminal; the installer pipe is never reused as the prompt input.
Every origin requires successful discovery. Missing, unreachable, mixed-origin,
or invalid discovery documents fail closed. The anonymously published runtime
is rebuilt without the operator's code, account, or relay endpoints; the
persisted discovery profile is its only sovereign control-plane configuration.

The installer writes the public release URL and signing public key to
`runtime/artifact-source.json`, installs a stable `~/.local/bin/sovereign` launcher
plus a deprecated `~/.local/bin/t3` rollback alias,
and runs the requested command. If a background service is already installed,
the installer reconciles that service through the newly verified runtime and
requires the restarted service to become active; it does not leave the live
environment pinned to the previous version. For `serve`, it first opens the
headless sovereign account flow and offers to install the durable user service.
If that service is accepted and active, it does not start a competing
foreground server. It never asks for or persists a GitHub, Gitea, Coolify, or
package credential. The account flow stores only the environment's normal
sovereign OAuth authorization. Subsequent use is:

```sh
sovereign serve
```

Both choices are durable across signed runtime upgrades and service restarts:

```sh
sovereign control-plane show
sovereign control-plane set https://code.example.com
sovereign control-plane reset

sovereign environment label show
sovereign environment label set "Atlas worker"
sovereign environment label reset
```

A control-plane change first validates discovery, revokes and clears the old
link and OAuth authorization when the effective endpoints actually change,
then restarts an installed user service and requires a fresh sign-in. A label
change restarts the service so relay reconciliation updates the display label
in place. It never rewrites `userdata/environment-id`, so projects, threads,
credentials, and the environment tunnel identity are not recreated merely
because the label changes. `reset` explicitly opts back into build defaults or
automatic host-label detection, respectively.

For operator-directed recovery, install an exact signed version without moving
the stable channel:

```sh
curl -fsSL https://get.moondiner.com/install |
  sh -s -- serve --version 0.0.32+sovereign.gCOMMIT
```

## Canary and rollback

Use one non-critical linked environment first. Run the public installer, finish
the account authorization, and accept background-service installation when
prompted:

```sh
curl -fsSL https://get.moondiner.com/install | sh -s -- serve
```

Then verify:

```sh
systemctl --user status sovereign.service --no-pager
sovereign --version
sovereign connect status --json
```

Test browser, desktop, and iOS reconnection; create a thread; stream a reply;
restart the service; and confirm the thread and environment return. The
existing launcher retains its SQLite snapshot and prior-version state. A
failed preflight never switches versions, and a failed post-switch start uses
the existing rollback protocol.

Only after the canary survives the restart and reconnect exercise should other
environments receive the source config and exact version.

## Key rotation and incident boundary

Signing-key rotation is explicit: create a new key, update the CI secret,
publish a new installer and version, then replace the public key on installed
remotes before requesting that version. Never overwrite an existing version.
If the signing private key is suspected compromised, remove the CI secret,
revoke both publisher tokens, keep remotes pinned to the last trusted installed
version, generate a new key, and audit every version published after the
compromise time.

## Deliberately deferred Rust component

A Rust updater/supervisor remains an optional later hardening project, not a
prerequisite and not a server rewrite. Its only justified scope would be the
small privileged lifecycle boundary: fetch, signature/hash verification,
atomic activation, process supervision, health timeout, and rollback. The
relay, orchestration server, protocol, persistence, and shared clients remain
TypeScript/Effect unless profiling or correctness evidence establishes a
specific reason to move them.
