# Sovereign T3 deployment

This stack deploys the hosted web client, Better Auth account service,
sovereign relay, and one PostgreSQL cluster with isolated account and relay
databases. FRPS is an opt-in Compose profile in the all-in-one bootstrap stack
and is always present in the production split control stack. It is designed
for a Coolify Docker Compose application. The two
`exclude_from_hc` service keys are Coolify-specific; remove those keys before
validating or running this file with an unmodified Docker Compose CLI.

The all-in-one `compose.yaml` remains the bootstrap and rollback manifest. A
long-lived deployment should use three independently managed Coolify resources:

- `t3-web` from `compose.web.yaml`;
- `t3-control` from `compose.control.yaml`;
- `t3-postgres` as a private Coolify PostgreSQL database resource.

The split control manifest expects complete `T3_ACCOUNT_DATABASE_URL` and
`T3_RELAY_DATABASE_URL` values. It deliberately does not own a database volume.
The web manifest has no database or private-network dependency and can be
deployed without interrupting remote environments.

FRPS has no profile gate in the split control manifest. Once the controlled
domain cutover is complete, every `t3-control` deployment must replace the
relay and FRPS together so a missing Coolify environment variable cannot take
all remote environments offline. Use the all-in-one manifest's `frps` profile
only for bootstrap or rollback rehearsals where its wildcard Traefik router
must not overlap production.

## Public topology

| Service           | Public address                    | Container port |
| ----------------- | --------------------------------- | -------------: |
| `code`            | `https://code.moondiner.com`      |           8080 |
| `account`         | `https://auth.moondiner.com`      |           4200 |
| `relay`           | `https://relay.moondiner.com`     |           4100 |
| `frps` HTTP vhost | `https://*.connect.moondiner.com` |           8080 |
| `frps` control    | `wss://connect.moondiner.com`     |           7000 |

PostgreSQL and the relay's FRPS authorization listener are private to the
Compose network. The relay reaches managed environments through
`http://frps:8080` while preserving their public `Host` headers; clients only
receive HTTPS/WSS endpoint URLs. FRPC control also enters through public HTTPS
port 443 and is forwarded as a WebSocket to Docker-private FRPS port 7000. No
FRPS port is published on the Coolify host.

At both Nginx tiers, only an exact WebSocket upgrade on `/~!frp` at
`connect.moondiner.com` can reach the FRPS control listener. Other apex paths
return 404, plain HTTP requests to that path return 426, the request body is
limited to 64 KiB, and new handshakes are limited per public client address.
Generated `*.connect.moondiner.com` environments remain ordinary proxied
HTTP/WebSocket services and retain their separate traffic limits.

The sovereign relay grants CORS only to `T3_CODE_URL` and the exact desktop
origins `t3code://app` and `t3code-dev://app`; arbitrary custom schemes and web
origins remain denied. Account rate limits use the `X-Real-IP` value
overwritten by the trusted proxy chain, and signup is fail-closed against
`T3_ACCOUNT_ALLOWED_EMAILS`. Each TLS proxy hop must validate the upstream
certificate; encryption without certificate verification is not an
authenticated transport boundary. The sovereign relay also omits the
interactive API documentation and OpenAPI routes from its Internet-facing
runtime.

The sovereign web image disables Google's remote favicon service. External
links and preview tabs use the local globe fallback, so merely rendering a
conversation or tab does not disclose visited hostnames to a third party. The
hosted web server also emits a restrictive baseline Content Security Policy;
arbitrary HTTPS/WSS connections remain allowed because connecting to remote
environments is a core product capability.

All sovereign Nginx access logs omit query strings, request headers, and
referrers. They retain only the normalized path and operational metadata, so
OAuth callback codes are not copied into proxy or web-container logs.

## Generate secrets

Generate every value once and store it in Coolify's environment configuration
and in an offline encrypted backup. Do not commit populated environment files.

```sh
openssl rand -hex 32 # T3_POSTGRES_ADMIN_PASSWORD
openssl rand -hex 32 # T3_ACCOUNT_DB_PASSWORD
openssl rand -hex 32 # T3_RELAY_DB_PASSWORD
openssl rand -hex 48 # T3_ACCOUNT_SECRET

openssl genpkey -algorithm Ed25519 -out relay-signing-private.pem
openssl pkey -in relay-signing-private.pem -pubout -out relay-signing-public.pem
base64 < relay-signing-private.pem | tr -d '\n'
base64 < relay-signing-public.pem | tr -d '\n'
```

The final two outputs are `T3_RELAY_SIGNING_PRIVATE_KEY_B64` and
`T3_RELAY_SIGNING_PUBLIC_KEY_B64`. Delete the unencrypted working copies only
after confirming the encrypted backup.

## Coolify application

1. Create a Docker Compose application from the private fork.
2. Set the base directory to `/` and the Compose file to
   `/infra/sovereign/compose.yaml`. The build contexts intentionally use `.`;
   Coolify supplies the repository root as Compose's project directory.
3. Add every variable from `.env.example`, replacing the secret placeholders.
   Set `T3_ACCOUNT_ALLOWED_EMAILS` to the exact email addresses permitted to
   create accounts.
4. Assign domains to services:
   - `code`: `https://code.moondiner.com:8080`
   - `account`: `https://auth.moondiner.com:4200`
   - `relay`: `https://relay.moondiner.com:4100`
5. Leave `COMPOSE_PROFILES` unset. Do not assign an FRPS domain or open its TCP
   port during the control-plane deployment.
6. Deploy. PostgreSQL initializes the two roles/databases once; checked Drizzle
   migrations and public OAuth-client reconciliation run before the long-lived
   services start.

The PostgreSQL image bakes in the versioned initialization script. Do not
replace it with a runtime bind mount: Coolify rewrites relative bind sources
into its generated application directory, where repository files are not
guaranteed to exist.

PostgreSQL's healthcheck deliberately waits for its final PID-1 server. The
temporary server used by the official image while executing initialization
scripts is not considered healthy, preventing migrations from racing its
shutdown.

The `account-migrate` and `relay-migrate` services are marked as one-shot jobs
for Coolify health evaluation. A successful stopped state is expected for both.

The long-lived relay process runs its cleanup once at startup and every five
minutes thereafter. Successful DPoP token exchanges and terminal/deletion
activity events also trigger best-effort cleanup, while the scheduled pass
repairs missed events after crashes or unavailable dependencies. Expired DPoP
replay rows, aged terminal activity rows, and APNs delivery-attempt audit rows
(30-day retention) must therefore remain bounded without any external cron
service. Mobile sign-out and account switching immediately schedule device
deregistration using the departing account's captured access token. The pass
also retries deprovisioning allocations that have no active managed link.
Orphan reconciliation waits 15 minutes and then uses the allocation generation
as a compare-and-swap guard against concurrent relinking.

Normal linking can intentionally share an environment across accounts. Use
`t3 connect link --headless --transfer` for an explicit account transfer. The
environment-signed transfer revokes prior links only when they use the same
environment signing key, then tears down their managed allocations. Failed
teardown is safe to retry and is recovered by the maintenance pass.

## Optional native iOS notifications

The iOS client obtains native APNs device and Live Activity tokens. Expo is not the push transport.
Sovereign deployments leave delivery disabled until `T3_APNS_ENABLED=true` and all Apple credential
variables in `.env.example` are present. When enabled, the relay writes signed jobs to its own
PostgreSQL outbox and processes them directly against Apple's APNs API. This replaces upstream's
Cloudflare Queue without replacing the tested upstream payload, signing, deduplication, stale-state,
or APNs client logic.

The outbox is durable across relay restarts, claims work atomically with `FOR UPDATE SKIP LOCKED`,
retries processing failures with bounded backoff, and marks a job `dead_letter` after five attempts.
It exposes no listener or additional public service. Its signed job body contains an APNs token, so
the relay database and every retained backup must be encrypted and access-restricted.

## Enable FRPS last during bootstrap

When using the all-in-one `compose.yaml`, validate the account, relay, web
session, and remote-environment protocol first, then add
`COMPOSE_PROFILES=frps`. The production `compose.control.yaml` starts FRPS
unconditionally. Then:

1. Assign both domains to `frps`:
   - public `https://connect.moondiner.com` to container port `7000` for FRPC
     control over WSS
   - public `https://*.connect.moondiner.com` to container port `8080` for
     managed environment traffic
     These are internal target ports in Coolify's route configuration; neither
     port is appended to the public URL.
     The Compose service also declares an explicit `HostRegexp` router for the
     wildcard route. Coolify 4.1.2 otherwise emits the literal rule
     ``Host(`*.connect.moondiner.com`)``, which does not match generated
     environment hostnames on the deployed Traefik version.
2. Keep host port 7000 closed. Coolify's HTTPS ingress reaches both listeners
   through the private Compose network.
3. Ensure every upstream Nginx preserves HTTP/1.1 WebSocket upgrades and uses
   long read/send timeouts for `connect.moondiner.com`.
4. Redeploy and verify remote FRPC registration before exposing clients.

The certificate must cover both `connect.moondiner.com` and
`*.connect.moondiner.com`. A `*.moondiner.com` certificate covers the former
but not the latter. Ordinary certificates for `code`, `auth`, and `relay` do
not cover managed environment hostnames.

The public `connect` virtual host must not inherit the temporary source-IP
allowlist used while bringing up the control plane. Remote FRPC clients and
browser/mobile clients can originate from arbitrary addresses. Connector
login and proxy creation remain authenticated by the relay-issued,
per-environment connector credential.

## DNS records

Point these records at the sovereign public ingress address. In the current
deployment that is the allowlisted edge Nginx, which forwards through the
second Nginx to Coolify; the Coolify host does not need to be directly exposed:

```text
code.moondiner.com
auth.moondiner.com
relay.moondiner.com
connect.moondiner.com
*.connect.moondiner.com
```

Use the DNS provider only for authoritative DNS. No Cloudflare application,
tunnel, database, identity, queue, or telemetry service is required.

The live edge, second-proxy, and Traefik TLS configurations plus the
certificate renewal/distribution runbook are versioned in [`proxy/`](proxy/).
Keep populated DNS credentials and certificate private keys on their owning
hosts; they never belong in this repository.

## Verification

After deployment:

```sh
curl --fail https://code.moondiner.com/health
curl --fail https://auth.moondiner.com/health
curl --fail https://relay.moondiner.com/health
curl --fail https://auth.moondiner.com/api/auth/jwks
curl --fail https://auth.moondiner.com/api/auth/.well-known/openid-configuration
```

Then link a persistent remote environment with the normal T3 CLI and verify
that its FRPC connection registers over WSS against
`connect.moondiner.com:443`. FRPS continues to listen on port 7000 only inside
the Compose network.

## First-party client builds

Web, desktop, and mobile clients consume the same public sovereign
configuration at build time. The desktop main process and bundled renderer must
be built in the same environment so neither side selects a different identity
provider. For local development, copy the public template once and use the
validated launcher:

```sh
cp infra/sovereign/client.env.example .env.local
vp run dev:sovereign:desktop --check
vp run dev:sovereign:desktop
```

The launcher fails before building when a required endpoint is absent, a public
endpoint is not HTTPS, third-party identity or client telemetry is configured,
or remote favicon fetching is enabled. It always stores development state under
the checkout's ignored `.t3` directory instead of the live T3 home. Publication
of the local desktop environment remains disabled by default; connecting to a
remote environment does not require enabling it.

For packaged artifacts, provide the same public variables in the build
environment and run:

```sh
set -a
. ./.env.local
set +a

vp run build:desktop
```

Keep all Clerk and relay-client OTLP variables unset for sovereign artifacts.
The desktop then selects its PKCE OAuth implementation, opens sign-in in the
system browser, accepts the registered `t3code://app/connect/account/callback`
callback, and stores the OAuth state with Electron `safeStorage`. Development
uses the separately registered `t3code-dev://` scheme.

The complete local-client procedure and troubleshooting checks are in
[`../../docs/operations/sovereign-clients.md`](../../docs/operations/sovereign-clients.md).
Run the component restart and persistence exercises in
[`../../docs/operations/sovereign-failure-recovery.md`](../../docs/operations/sovereign-failure-recovery.md)
after every material control-plane or tunnel lifecycle change.
The private, credential-free health monitor and self-hosted alert contract are
documented in
[`../../docs/operations/sovereign-observability.md`](../../docs/operations/sovereign-observability.md).
Logical dump validation, retention boundaries, and the separate remote T3 home
backup requirement are documented in
[`../../docs/operations/sovereign-backup-restore.md`](../../docs/operations/sovereign-backup-restore.md).

The source tree retains upstream Clerk adapters for shallow-fork compatibility.
They are dormant when the complete sovereign OAuth configuration is present;
no Clerk publishable key is embedded and the runtime selects the sovereign
identity layer. A partially configured OAuth tuple fails closed instead of
falling back to Clerk.

## Continuous deployment

`.gitea/workflows/sovereign-ci-deploy.yml` validates the sovereign services,
typechecks and builds the desktop sovereign client,
requests both application deployments with `POST /api/v1/deploy`, polls each
deployment UUID until Coolify reports `finished`, and then verifies the live
health, OAuth/JWKS, relay authentication boundary, hostile-origin CORS,
disabled documentation routes, strict Host handling, fail-closed Connect apex
paths, edge security headers, and Connect WebSocket upgrade. A failed,
cancelled, unknown, or 20-minute-stalled deployment fails the workflow.

The repository requires `COOLIFY_URL`, `COOLIFY_CONTROL_UUID`, and
`COOLIFY_WEB_UUID` Actions variables. `COOLIFY_TOKEN` must be an Actions secret
whose Coolify API token has only the `deploy` and `read` abilities needed to
queue deployments and read their completion status. It does not need `write`.
