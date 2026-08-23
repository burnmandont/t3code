# Sovereign failure-recovery exercises

Run these exercises after a green sovereign deployment and before materially
changing ingress, persistence, or tunnel configuration. They validate that a
single component failure is recoverable without replacing environment
identity, connector credentials, managed hostnames, or thread state.

These are production-impacting exercises. Run one at a time, stop when the
baseline is not healthy, and never combine a database restart with a relay or
FRPS restart.

## Invariants

- `code`, `auth`, and `relay` health return 200 before and after each exercise.
- An exact WebSocket upgrade to `https://connect.moondiner.com/~!frp` returns
  101 while FRPS is available.
- A linked environment route returns an environment-owned response rather than
  an ingress 502 or 503.
- FRPS control port 7000, HTTP vhost port 8080, relay port 4100, account port
  4200, and PostgreSQL port 5432 remain unpublished on the Docker host.
- Restarting infrastructure does not change the environment ID, allocated
  hostname, or stored thread history.
- Recovery uses the existing supervised connector. It must not require a new
  `t3 connect link`, credential rotation, or account login.

## Resolve exact targets

On the Coolify deployment host, resolve each container by its Compose service
label and require exactly one match. Do not restart a container found only by a
name substring.

```bash
resolve_one_service() {
  service_name=$1
  matches=$(docker ps -q --filter "label=com.docker.compose.service=$service_name")
  count=$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || {
    printf 'Expected one running %s container; found %s\n' "$service_name" "$count" >&2
    return 1
  }
  printf '%s\n' "$matches"
}
```

Resolve the private Coolify PostgreSQL resource by its exact resource UUID or
container ID recorded in the deployment inventory. It does not carry the
control stack's Compose service label.

## Establish the baseline

```bash
for host in code.moondiner.com auth.moondiner.com relay.moondiner.com; do
  curl -fsS -o /dev/null -w "$host %{http_code}\n" "https://$host/health"
done

curl --max-time 5 --http1.1 -sS -o /dev/null -w 'connect %{http_code}\n' \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Origin: https://connect.moondiner.com' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://connect.moondiner.com/~!frp'
```

Record the linked environment's ID, hostname, a durable thread ID, and the
current container creation times. The WebSocket probe timing out after a 101
upgrade is expected; a 502 or 503 is a failure.

## Exercise order

### 1. FRPS restart

Restart only the exact FRPS container. The control upgrade and managed
environment route may be briefly unavailable. The remote `frpc` supervisor
must reconnect and restore the same hostname without relinking.

```bash
frps_id=$(resolve_one_service frps) || exit 1
docker restart "$frps_id"
```

Pass when the WebSocket upgrade returns 101, the existing environment route is
not 502/503, and the environment becomes usable from a client again.

### 2. Remote T3 service restart

On one linked remote environment, restart the exact user service:

```bash
systemctl --user restart t3code.service
systemctl --user is-active t3code.service
```

Pass when the same managed hostname recovers, the same environment ID is
listed, and the recorded thread can be opened. A new link is a failure.

### 3. Relay restart

```bash
relay_id=$(resolve_one_service relay) || exit 1
docker restart "$relay_id"
```

The relay health endpoint must recover. The already-established FRP data path
should remain available, while new relay discovery or token exchanges may fail
briefly. Event cleanup missed during the outage is repaired by the startup
maintenance pass and five-minute reconciliation loop.

### 4. Account restart

```bash
account_id=$(resolve_one_service account) || exit 1
docker restart "$account_id"
```

The account health and OIDC discovery/JWKS routes must recover. Existing
environment connections should remain usable. A client may need to refresh an
expired account token after recovery, but must not lose its local environment
registration.

### 5. Hosted web restart

```bash
code_id=$(resolve_one_service code) || exit 1
docker restart "$code_id"
```

The hosted web health endpoint must recover and a browser reload must restore
the signed-in account and saved remote environments. Remote T3 and FRPS remain
unaffected.

### 6. PostgreSQL restart

Restart only the recorded private PostgreSQL resource. Do not remove or
recreate its volume.

```bash
docker restart EXACT_POSTGRES_CONTAINER_ID
```

Account and relay requests may fail while PostgreSQL is unavailable. Both
services must reconnect without being redeployed. Verify the account, linked
environment, allocation hostname, and recorded thread after recovery.

### 7. Deployment replacement

Deploy `t3-control` normally. Account, relay, and FRPS must all be present
after replacement. The production split manifest deliberately starts FRPS
without a Compose profile so a missing Coolify environment variable cannot
silently remove the tunnel service.

## Abort conditions

Stop the exercise and preserve logs if any of these occur:

- more than one target resolves for a supposedly singleton service;
- a service remains unhealthy after its normal health-check retry window;
- recovery changes the environment ID or managed hostname;
- a connector requires relinking or a new credential;
- PostgreSQL reports recovery, corruption, or migration errors;
- an internal service port becomes reachable from the Internet;
- logs contain bearer tokens, DPoP proofs, connector credentials, OAuth codes,
  or URL query strings.

Do not delete containers or volumes as a recovery step. Capture container logs,
health state, and creation timestamps first; then use the last known-good
Coolify deployment or the documented all-in-one rollback manifest.

## Cleanup semantics

Cleanup is event-driven on successful token exchange, terminal agent activity,
environment unlink, and explicit transfer. Those paths are the normal low
latency mechanism. The relay also reconciles at startup and every five minutes
because a process can die after committing state but before completing an
external teardown, or PostgreSQL/FRPS can be unavailable when the event is
handled. Reconciliation is therefore an idempotent repair mechanism, not the
primary lifecycle trigger.
