# T3 Connect Relay

> [!NOTE]
> Sign in to T3 Connect from the app under Settings > Connections.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture overview](../../docs/internals/t3-code-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Sovereign Runtime (in progress)

`src/sovereign.ts` runs the existing relay API as a conventional Node service and runs the private
frps authorization callback on a second listener. It uses ordinary PostgreSQL, the `t3_relay`
endpoint provider, JWKS-verified OAuth access tokens, and local logs. APNs is disabled by default;
when explicitly enabled, a PostgreSQL outbox and in-process worker replace Cloudflare Queues while
the existing provider-token signing, payload validation, stale-state checks, and Apple delivery
client remain unchanged. The runtime does not read Clerk, Cloudflare, PlanetScale, or Axiom
configuration. It communicates directly with Apple's APNs endpoints and never uses Expo Push.

The Node process also runs relay maintenance immediately at startup and every five minutes. It
prunes expired DPoP replay records, terminal agent-activity rows using the same retention policy as
the upstream Worker, and APNs delivery-attempt audit rows after 30 days. Token exchange and
terminal/deletion activity events perform their corresponding cleanup opportunistically. Mobile
sign-out and account switching deregister the departing account's device with a captured credential
before that credential can be replaced. Event cleanup is best-effort so a maintenance failure never
rejects an otherwise valid authorization or activity update; the periodic pass logs failures and
retries on the next cycle. The same reconciliation pass deprovisions allocation rows that no longer
have an active managed link, including teardown left incomplete by a failed unlink or account
transfer.
Background cleanup waits through a 15-minute orphan grace period and uses allocation-generation
compare-and-swap checks so it cannot tear down a tunnel that is concurrently being linked.

Environment sharing remains the default. To move a machine exclusively to another account, run
`t3 connect link --transfer` while authorizing the destination account. Transfer intent is bound
into the signed link challenge and revokes only other users linked with that exact environment
signing key; an environment-ID collision alone cannot take over an existing link.

Apply the relay schema to an empty database, then start the process:

```sh
export T3_RELAY_DATABASE_URL='postgres://...'
vp run --filter t3code-relay sovereign:db:migrate
vp run --filter t3code-relay sovereign
```

Required runtime configuration:

- `T3_RELAY_DATABASE_URL`: owned PostgreSQL connection URL.
- `T3_RELAY_ISSUER`: canonical public relay origin.
- `T3_RELAY_ALLOWED_ORIGINS`: comma-separated exact browser origins permitted by relay CORS. Native
  clients do not require CORS; do not use `*` for an Internet-facing sovereign deployment.
- `T3_RELAY_SIGNING_PRIVATE_KEY` and `T3_RELAY_SIGNING_PUBLIC_KEY`: Ed25519 PKCS#8/SPKI PEM used
  by the existing relay and environment mint-proof protocol.
- `T3_OIDC_ISSUER`, `T3_OIDC_AUDIENCE`, and `T3_OIDC_JWKS_URL`: owned OAuth 2.1 issuer, relay
  resource identifier, and JWKS URL.
- `T3_MANAGED_ENDPOINT_BASE_DOMAIN`: environment endpoint zone.
- `T3_FRPS_SERVER_ADDR`: address remote frpc connectors can reach.

Optional sovereign APNs configuration:

- `T3_APNS_ENABLED=true` opts into direct Apple Push Notification service delivery. It is false by
  default and partial configuration fails relay startup rather than silently dropping pushes.
- `T3_APNS_ENVIRONMENT` is `sandbox` for development-signed iOS builds and `production` for
  distribution builds. A device's registered APS environment and bundle id override these defaults.
- `T3_APNS_TEAM_ID`, `T3_APNS_KEY_ID`, and `T3_APNS_BUNDLE_ID` identify the Apple developer team,
  APNs `.p8` key, and fallback app bundle.
- `T3_APNS_PRIVATE_KEY_B64` is the base64-encoded contents of the Apple `.p8` private key.
- `T3_APNS_DELIVERY_JOB_SIGNING_SECRET` is an independently generated secret of at least 32
  characters (`openssl rand -hex 32`).

The queue body contains the destination APNs token. Protect the relay database and its backups as
secrets. Successful jobs are deleted; a job is moved to `dead_letter` after five processing failures
and records only a bounded error code outside its signed body. Operators should diagnose and delete
dead-letter rows rather than exporting their payloads.

For a local sovereign relay whose managed wildcard names do not resolve through the host DNS,
set `T3_MANAGED_ENDPOINT_DIAL_HOST` to the local frps HTTP listener address, such as
`127.0.0.1`. Relay-to-environment health and credential-mint requests then dial that address while
preserving the allocated hostname in the HTTP `Host` header used by frps virtual-host routing. The
public endpoint returned to clients is unchanged. Do not include a port; the configured managed
endpoint HTTP port remains authoritative.

For a container deployment where the private route also uses a different scheme or port, prefer
`T3_MANAGED_ENDPOINT_DIAL_ORIGIN`, for example `http://frps:8080`. It replaces only the network
dial origin. The public managed endpoint URL and its `Host` header remain unchanged. This avoids
public-DNS hairpinning between a co-located relay and frps.

The remaining variables have local-development defaults in `src/sovereign.ts`. The frps plugin
listener defaults to `127.0.0.1:4101` and must remain on loopback or a private service network. A
matching frps configuration is:

```toml
[[httpPlugins]]
name = "t3-sovereign-authorization"
addr = "127.0.0.1:4101"
path = "/internal/frp/authorize"
ops = ["Login", "NewProxy", "Ping", "CloseProxy"]
```

Schema changes are generated into `infra/relay/drizzle`; keep the Drizzle schema, generated
migration, and snapshot in the same commit. Better Auth account tables will use their own generated
migration boundary rather than being handwritten into the relay schema.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter t3code-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk and APNs credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The `prod` Alchemy stage owns the retained PlanetScale database and is the shared hosted relay for
stable and nightly clients. Every other stage references that database and provisions an isolated
PlanetScale branch and runtime role for local development, so deploy `prod` before creating
developer stages:

```sh
vp run --filter t3code-relay deploy -- --stage prod
vp run --filter t3code-relay deploy -- --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [T3 Connect Clerk Setup](../../docs/internals/t3-connect.md) for Clerk keys, JWT templates, and sign-up restrictions
  setup.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [T3 Connect Architecture Overview](../../docs/internals/t3-code-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.
