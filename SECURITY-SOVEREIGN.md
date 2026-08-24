# Sovereign deployment security gate

Status as of 2026-08-06: the control plane remains source-IP restricted. T3
Connect is public because remote FRPC connectors and linked environments must
reach it. Do not remove the control-plane allowlist until every remaining gate
below is closed.

## Public surface

| Host                      | Purpose                                   | Public authentication boundary                                                |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `code.moondiner.com`      | Static hosted client                      | Public assets; application data requires account/relay authentication         |
| `auth.moondiner.com`      | Better Auth and OAuth issuer              | Secure cookies, exact trusted origins, email/password login, signup allowlist |
| `relay.moondiner.com`     | Control-plane API                         | OIDC bearer or DPoP-bound access token, depending on route                    |
| `connect.moondiner.com`   | FRPC control over WSS                     | Per-environment connector credential checked by the FRPS authorization plugin |
| `*.connect.moondiner.com` | Linked environment HTTP/WebSocket traffic | Environment session, scoped bearer/DPoP credentials, or signed relay proofs   |

Relay health and OAuth discovery metadata remain public. Interactive relay docs,
OpenAPI output, and the relay root redirect are disabled in the sovereign
runtime. Unauthenticated relay data access returns 401.

## Authentication controls

- Account creation fails closed unless the request is valid JSON and its exact,
  normalized email is in `T3_ACCOUNT_ALLOWED_EMAILS`.
- Passwords for new accounts must be 12–128 characters. Email verification is
  currently disabled because no sovereign delivery system is configured.
- Better Auth reads the single `X-Real-IP` header overwritten by the trusted
  proxy chain for rate-limit identity. Email sign-in is limited to 3 attempts
  per 10 seconds per client and signup to 5 attempts per hour per client.
- OAuth dynamic client registration is disabled. Provisioned redirect URIs are
  limited to HTTPS, loopback HTTP, the current `sovereign:`, `sovereign-dev:`,
  and `sovereign-preview:` schemes, plus the temporary exact `t3code:` and
  `t3code-dev:` rollback callbacks. Credentials, arbitrary schemes, and URL
  fragments are rejected.
- The OAuth provider has exactly one valid resource audience, the relay. The
  relay independently verifies issuer, exact audience, expiry, EdDSA signature,
  and the `t3:relay` scope.
- Relay DPoP verifies ES256 signatures, method, normalized URL, access-token
  hash, key thumbprint, proof time, and persisted replay state.
- Environment and allocation queries are keyed by both authenticated user ID
  and environment ID. FRPS accepts only the allocated canonical HTTP proxy,
  hostname, connector ID, and an encrypted FRP proxy definition.

## Transport boundary

The Internet and routed-LAN proxy hops are authenticated and encrypted:

1. Client to edge Nginx: HTTPS/WSS with the public SAN certificate.
2. Edge Nginx to second Nginx: HTTPS with hostname and CA verification.
3. Second Nginx to Coolify Traefik: HTTPS with hostname and CA verification.
4. FRPC to FRPS: WSS on public port 443; FRP proxy encryption is mandatory.

This is not literal application-to-database end-to-end TLS. Traefik terminates
TLS and talks HTTP to containers on a private Docker network. Relay-to-FRPS and
relay-to-environment dial traffic is also HTTP on that private Docker network,
while FRPS carries it inside the encrypted FRP tunnel. PostgreSQL is private and
not host-published, but its current application connections do not require TLS.
An attacker who already controls the Coolify host or Docker network is outside
the current transport threat boundary. Closing that gap would require internal
TLS or mTLS for every service and PostgreSQL.

The T3 containers expose Docker-network ports only: account 4200, relay 4100,
FRPS 7000/8080, web 8080, and PostgreSQL 5432. None is published directly on the
host.

## Edge abuse controls

The public edge currently applies:

- control-plane request rate: 20 requests/second/client, burst 80;
- Connect request rate: 30 requests/second/client, burst 100;
- 100 concurrent processed connections per client IP;
- 5,000 concurrent processed connections per T3 virtual host;
- 429 for request or connection limit rejection;
- a 2 MiB body limit for code/auth/relay and 100 MiB for Connect;
- TLS 1.2/1.3 only, HSTS for one year, `nosniff`, `DENY` framing, and
  `no-referrer`;
- no unsupported HTTP/3 advertisement through the TCP-only Nginx edge.

These limits protect application capacity; they cannot stop a volumetric attack
that saturates the edge network before Nginx. Confirm an Akamai/Linode Cloud
Firewall is attached with inbound default-drop and only intentional public
ports. Provider/network-layer mitigation is required for meaningful volumetric
DDoS resistance without a CDN or external scrubbing network.

The 2026-08-07 host audit found firewalld active with default rejection at the
end of its public-zone input path. External IPv4 and IPv6 checks reached only
TCP 22, 80, and 443; TCP 4100, 4200, 5432, 7000, 8000, 8080, and 9090 were
closed or filtered. The unused Cockpit allowance and redundant raw-port entries
were removed from both runtime and persistent firewalld policy after the audit.
SSH remains reachable from any source to preserve travel access, but it is
key-only: password and keyboard-interactive authentication are disabled, root
is restricted to public-key login, and pre-authentication limits are tightened.
The forced certificate-export key continues to work under the same public-key
policy. An enabled Akamai/Linode Cloud Firewall is attached to the edge public
interface with inbound default-drop and outbound default-accept. It permits only
TCP 22/80/443 plus ICMP; external checks confirmed that application, database,
FRP, Coolify, and Cockpit ports are silently dropped.

## Advisory triage

The 2026-08-07 `pnpm audit --prod` triage distinguished deployable artifacts
from package-manifest paths. The runtime control-plane image contains
self-contained esbuild bundles rather than the build dependency tree, so
findings in Vitest, drizzle-kit, and other build-only packages are not runtime
findings. Electron findings reached `apps/web` only through its desktop adapter;
Electron is absent from the deployed static web artifact and remains part of the
separate desktop gate.

One advisory directly names the deployed OAuth provider:
`GHSA-p2fr-6hmx-4528`. The current stable 1.6.x line has no patched stable
release. Its documented workaround is in place: the issuer has exactly one
`validAudiences` entry, and the relay rejects any token without its own exact
audience. Upgrade to Better Auth 1.7 stable and run the required schema migration
when that upgrade is intentionally tested.

Reviewed overrides now pin the remote environment chain to MCP SDK 1.30.0,
`@hono/node-server` 2.1.0, Hono 4.13.1, `fast-uri` 3.1.5, and `ip-address`
10.4.0. The relay build dependency is pinned to Undici 7.29.0. These versions
clear every advisory path into `apps/server` and `infra/relay`. Compatibility
was verified by server typechecking, a production bundle, 62 focused
Claude/MCP tests, and the complete server suite: 201 files and 1,829 tests
passed, with two files and seven tests intentionally skipped.

## Remaining go/no-go gates

- [ ] Replace manual DNS-01 renewal with an acceptably scoped issuer. The
      Namecheap account API design is rejected; atomic three-tier distribution
      and the restricted second-proxy pull timer are active.
- [x] Version the live T3-only edge, second-proxy, and Traefik TLS
      configurations and provide a read-only drift check.
- [x] Confirm Akamai/Linode Cloud Firewall attachment and inbound default-drop;
      retain the host firewall as a second layer. The enabled firewall is
      attached to the public interface for `45.79.202.71`; its outbound policy
      is accept, and external checks after attachment reached only the intended
      TCP 22/80/443 services.
- [x] Resolve or explicitly accept the runtime-relevant remote-server dependency
      advisories after focused compatibility tests. All known remote-server and
      relay-chain findings are patched; the Better Auth stable-line advisory is
      explicitly mitigated as documented above.
- [ ] Confirm the first production run of the new CI deployment gate. The
      workflow now polls both Coolify deployment UUIDs to terminal success and
      then checks service health, OAuth/JWKS, relay rejection of an invalid
      bearer, edge security headers, and the Connect WebSocket upgrade.
- [ ] Run an authenticated browser regression: login, list environments, connect,
      dispatch a short task, stream output, close, and reconnect.
- [ ] Build and test the desktop client against the same sovereign issuer and
      relay before opening the control-plane hosts to arbitrary source IPs.
- [ ] Decide whether the owner account requires TOTP MFA before public exposure.
- [ ] Decide whether Docker-private HTTP and non-TLS PostgreSQL are acceptable or
      whether the threat model requires internal mTLS/TLS.
- [ ] Keep tested backups for account and relay databases and perform a restore
      drill.

Only after these gates should the temporary source-IP allowlist on
`code.moondiner.com`, `auth.moondiner.com`, and `relay.moondiner.com` be removed.
