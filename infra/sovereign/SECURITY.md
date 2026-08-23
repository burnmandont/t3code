# Sovereign deployment security review

Last reviewed: 2026-08-10

This review covers the Internet-facing sovereign deployment, not the complete
upstream T3 Code product. Its primary security property is that possession of a
hostname is never sufficient to orchestrate an environment.

## Trust boundaries

1. The public edge terminates client TLS, enforces connection/request limits,
   overwrites forwarding headers, and validates the second proxy's certificate.
2. The second proxy accepts only the enumerated edge addresses, recovers the
   public client address from that trusted hop, and validates Traefik's
   certificate.
3. Traefik routes only to private Compose-network ports. PostgreSQL, FRPS ports
   7000/8080, and the relay's FRPS authorization plugin are not host-published.
4. The account service authenticates the human. The relay authorizes account,
   device, environment, and connector operations. Each environment performs
   its own pairing/session authorization for HTTP and WebSocket RPC.

The TLS-terminating proxies can observe plaintext HTTP by design. They are
therefore trusted components, not opaque transport hops.

## Public route matrix

| Surface          | Intentionally public                                                                | Protected operations                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted web       | Static application and `/health`                                                    | The static app has no environment authority by itself                                                                                                                    |
| Account          | Sign-in UI, health, passkey, session, OIDC discovery/JWKS and OAuth protocol routes | Account session and OAuth authorization; every email/password and recovery route is restricted to operator source addresses, and sign-up is also exact-email allowlisted |
| Relay            | Health and OAuth/DPoP discovery                                                     | Bearer or DPoP authentication on environment, link, device, and activity routes                                                                                          |
| Connect apex     | Exact WebSocket upgrade at `/~!frp`                                                 | FRPS Login and proxy operations require a relay-issued connector token                                                                                                   |
| Connect wildcard | Traffic to one registered environment hostname                                      | The environment requires a pairing credential, session cookie, bearer token, DPoP token, or one-time WebSocket ticket before privileged access                           |

Environment hostnames are deterministic but opaque. Their secrecy is not an
authorization control. An unauthenticated visitor may retrieve the static UI
and minimal environment authentication metadata; orchestration, terminal,
filesystem, and WebSocket RPC operations require scoped credentials.

## Implemented controls

- TLS 1.2/1.3 and certificate verification on every proxy hop.
- No public PostgreSQL, relay-internal plugin, FRPS control, or FRPS vhost port.
- Exact account CORS origins and fail-closed signup allowlist.
- A duplicated edge and second-proxy source boundary around every account
  route that can consume, create, change, reset, or verify a password. Passkey,
  OAuth, and session routes remain public.
- Better Auth request limits, including tighter sign-in and sign-up buckets.
- Relay bearer validation, DPoP proof binding, nonce/replay handling, and
  scoped environment credentials.
- Constant-time FRP connector-token comparison and an allowlist of FRP
  operations, proxy name, proxy type, hostname, and encrypted transport.
- Separate public-edge limits for the control plane, environment traffic, and
  FRP WebSocket handshakes.
- Exact `/~!frp` routing, WebSocket enforcement, a 64 KiB handshake body cap,
  exact same-host Origin enforcement, and fail-closed apex paths at both Nginx
  tiers. The allowlist includes FRP 0.70.1's native `http://` Origin and the
  private monitor's `https://` Origin; connector tokens remain the actual
  authorization boundary.
- A 64 KiB body cap around every small environment bootstrap, token-exchange,
  pairing-token, WebSocket-ticket, and relay-signed control route at both
  Nginx tiers. Large authenticated orchestration dispatches retain their
  separate upload allowance.
- An explicit edge default server that returns 421 for unknown SNI/Host values
  instead of routing them through an unrelated virtual host.
- HSTS, anti-framing, MIME-sniffing and referrer headers.
- A hosted-web Content Security Policy that blocks third-party scripts and
  inline script attributes while retaining arbitrary HTTPS/WSS connections
  required for user-selected remote environments.
- Remote favicon fetching disabled in the sovereign build. Rendering a link or
  preview tab does not disclose its hostname to Google.
- Query-free structured access logs. OAuth codes, authorization headers,
  referrers, and request bodies are not included in routine Nginx logs.
- A private, portless monitor exercises the public health and FRP upgrade
  paths, becomes Docker-unhealthy after sustained failure, and emits bounded
  failure/recovery events without credentials or managed hostnames.
- Account and relay health require successful PostgreSQL queries rather than
  reporting process liveness as dependency readiness.
- Optional APNs delivery talks directly to Apple over a dedicated HTTP/2
  transport. Its `.p8` key and job-signing secret are runtime-only variables;
  the Cloudflare Queue and Expo Push services are not used. The PostgreSQL
  outbox atomically claims jobs, bounds retries, and does not log device tokens.
- Public relay documentation and OpenAPI endpoints disabled.
- CI verifies account/relay/web tests, the hosted build, configuration
  invariants, completed Coolify deployments, health, OAuth/JWKS, invalid relay
  authentication, hostile-origin CORS, disabled documentation routes, Host
  rejection, fail-closed Connect paths, security headers, CSP, and the Connect
  WebSocket upgrade. A terminal Coolify failure receives one bounded retry for
  only the failed resource; cancellation, unknown state, and timeout remain
  fail-closed rather than risking overlapping deployments.
- Remote-server releases are complete, immutable, commit-addressed artifacts
  in the self-hosted Gitea Generic Package Registry. An offline-rooted Ed25519
  signature binds version, platform, filename, size, SHA-256, and commit. A
  configured remote fails closed instead of falling back to public npm, and
  the same signed archive supplies its pinned FRP client.

## Residual risks and decisions

### Completed exposure gates

- On 2026-08-08, the broad control-plane source allowlist was removed in the
  order account, relay, hosted web. Each hostname was tested from a
  non-operator source before the next was opened. Public passkey/OAuth account
  routes returned 200, every password route returned 403, an invalid relay
  bearer returned 401, relay documentation remained 404, hostile CORS was
  rejected, and direct second-proxy requests returned 403. The second proxy
  now separately requires an enumerated original edge peer even after
  restoring the public client address.
- On 2026-08-08, a credential-free client outside the environment exercised a
  real managed endpoint. Public descriptor and anonymous session metadata
  returned 200. Anonymous and invalid-bearer orchestration reads, invalid
  browser pairing, invalid OAuth bootstrap exchange, and unauthenticated
  WebSocket upgrade all returned 401. The environment reported zero pairing
  credentials and zero sessions after the probes; its server and FRPC processes
  remained running.
- The provider and host firewalls expose only 22, 80, and 443. Direct probes to
  application, PostgreSQL, FRPS, Coolify, and internal HTTP ports timed out, and
  the SSH administrative recovery path remains available.
- Relay regression tests assert that environment list and lookup queries are
  scoped to the authenticated OAuth subject and that a connector performs no
  environment request when that subject has no matching link.
- On 2026-08-10, isolated restarts of FRPS, the active remote T3 service,
  relay, account/OIDC, hosted web, PostgreSQL, the second proxy, and the public
  edge all recovered without changing the environment ID, managed hostname,
  or recorded thread state. PostgreSQL performed an orderly shutdown without
  crash recovery. The public edge retained strict Host rejection, and neither
  proxy restart exposed an internal port or required connector relinking. The
  complete procedure and runtime-baseline correction are recorded in the
  failure-recovery runbook.

### Accepted or deferred

- Per-IP Nginx limits mitigate ordinary abuse but cannot absorb a volumetric or
  widely distributed denial-of-service attack. Capacity protection must occur
  before traffic reaches the VM; this deployment intentionally does not use a
  third-party CDN or scrubbing proxy.
- The sovereign bundle still contains inactive upstream Clerk code because the
  multi-surface entry point statically supports both identity providers. No
  Clerk key is compiled into the image, the sovereign provider is selected,
  and CSP blocks Clerk's third-party script path. Removing that inactive code
  is a bundle-hardening optimization, not an active network dependency.
- `connect-src` permits arbitrary HTTPS/WSS destinations because direct and
  user-selected remote environments are upstream product capabilities. A
  domain-only policy would be stronger but would intentionally remove those
  modes.
- Manual DNS-01 certificate renewal remains accepted until a credential with a
  genuinely narrow DNS authority boundary is available.
- APNs is disabled until the operator supplies an Apple key. When enabled, the
  relay database temporarily contains signed outbox bodies with destination
  device tokens; database access and every retained backup must therefore be
  treated as secret material. Apple APNs remains an unavoidable external
  dependency for native iOS notifications.
- The operator deliberately chose one platform passkey instead of a second
  hardware authenticator. This retains a device or credential-provider failure
  domain, depending on whether the passkey is synchronized. Recovery therefore
  depends on the independent Coolify/SSH, PostgreSQL, and proxy-administration
  path. Email/password login remains enabled as a recovery mechanism, but both
  Nginx tiers restrict every credential route to the operator's source
  addresses. A compromised password is therefore not remotely usable from an
  arbitrary network unless the proxy boundary is also bypassed.
- The production host and PostgreSQL instance now have encrypted recovery
  points on the separate Coolify control host, but the public edge, second
  proxy, control host, and retained copies remain in one site. This protects
  against a production-host loss, not a site loss; a second encrypted replica
  remains an operational priority.

## Controlled exposure sequence

1. Deploy the web hardening and require a green sovereign CI run.
2. Install the versioned proxy files with the rollback-capable installer.
3. Verify `nginx -t`, health 200 responses, Connect WebSocket 101, Connect apex
   404/426 behavior, Host rejection, and query-free access logs.
4. Install and test the operator-only password and recovery route boundary at
   both Nginx tiers.
5. Run the untrusted-network linked-environment checks.
6. Remove the control-plane source allowlists for one hostname at a time:
   account, relay, then hosted web. Re-run the complete smoke suite after each
   change and retain the last known-good proxy backups.
