# Sovereign adversarial security validation

This runbook validates the public sovereign T3 boundary without credentials,
brute force, sustained load, destructive payloads, or access to another
tenant. Run it after proxy, authentication, relay, FRP, or environment-auth
changes and before removing a temporary source allowlist.

## Safety boundary

- Target only infrastructure owned by the operator.
- Send one request per case. Do not use scanners with recursive discovery,
  password lists, concurrency, or rate-limit evasion.
- Use fake fixed credentials that cannot be mistaken for production secrets.
- Never put OAuth codes, cookies, connector tokens, or bearer tokens in a URL,
  shell history, access log, or report.
- Treat `429` as a successful protection signal and stop; do not attempt to
  measure the exhaustion threshold against production.

## Expected public matrix

| Probe                                                                                      | Expected result                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Control, account, and relay `/health`                                                      | `200`                                      |
| Environment `/.well-known/t3/environment`                                                  | `200`                                      |
| Environment `/api/auth/session` without a credential                                       | `200`, unauthenticated                     |
| Environment orchestration, pairing-token, WebSocket-ticket, and `/ws` without a credential | `401`                                      |
| Environment browser-session with a fake credential                                         | `401`                                      |
| Relay environment list with missing, fake bearer, or malformed DPoP                        | `401`                                      |
| Account preflight from an untrusted origin                                                 | `403`, no CORS grant                       |
| Relay preflight from an untrusted, `null`, or lookalike origin                             | no CORS grant                              |
| Unknown Host routed over a valid sovereign TLS name                                        | `421`                                      |
| Connect apex `/` and non-WebSocket `/~!frp`                                                | `404` and `426`                            |
| FRP WebSocket with canonical native or monitor Origin                                      | `101`                                      |
| FRP WebSocket with hostile, lookalike, missing, or `null` Origin                           | `403`                                      |
| Small environment credential/control body over 64 KiB                                      | `413`                                      |
| TLS 1.0/1.1 and TLS 1.2/1.3                                                                | rejected and accepted, respectively        |
| Direct request to the second proxy                                                         | `403` before application routing           |
| Password-capable account route from a non-operator source                                  | `403`                                      |
| `TRACE` on hosted web, account, and relay                                                  | never `2xx`                                |
| OAuth JWKS                                                                                 | public keys present; no private `d` member |

The anonymous descriptor and session document are not findings. They disclose
only the endpoint/authentication contract needed by clients. Hostnames are not
authorization secrets.

## Identity and availability invariant

After a proxy policy change, restart one linked test environment once. The
same environment ID and managed hostname must return, `t3 connect status
--json` must show `authenticated`, `linked`, and not `retired`, and an existing
client must reconnect without re-linking. This proves the policy admits the
real native FRPC handshake rather than only a synthetic monitor request.

## Log review

Inspect the edge, second proxy, relay, account, FRPS, and test-environment logs
after the probes. Access logs must contain normalized paths only—not query
strings, authorization headers, cookies, request bodies, OAuth codes, or
connector metadata. A rejected credential may be classified by reason, but
its bytes must not be logged.

## Validated production result (2026-08-10)

The credential-free pass confirmed:

- every protected environment and relay route rejected missing or malformed
  credentials;
- hostile account and relay origins received no CORS grant;
- TLS 1.0/1.1 were rejected and TLS 1.2/1.3 were accepted;
- all control-plane and environment routes rejected direct second-tier access;
- every password-capable account route returned `403` from the non-operator
  edge host even with a forged operator `X-Forwarded-For` value;
- unauthenticated environment WebSocket RPC returned `401`;
- canonical FRPC and monitor origins returned `101`, while hostile, lookalike,
  and `null` origins returned `403` after exact-origin hardening;
- browser-session, pairing-token, and WebSocket-ticket bodies above 64 KiB
  returned `413` after the small-control cap was completed;
- a forced restart of the linked `development` environment re-established its
  existing managed route in six seconds without re-linking or identity change.

No authorization bypass, cross-tenant access, private-key exposure, direct
internal-port exposure, or credential leakage was observed. Authenticated
two-account tenant-isolation behavior remains covered by relay integration
tests and should also be exercised manually whenever ownership rules change.
