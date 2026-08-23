# Sovereign observability and alerts

The sovereign deployment does not send traces, metrics, errors, or usage data
to Axiom, Clerk, Expo, or another hosted observability service. Its operational
model is deliberately first-party:

- account and relay health perform real PostgreSQL queries;
- Docker/Coolify health supervises every long-lived service;
- the private `monitor` container probes all public TLS/proxy paths and the
  exact FRP WebSocket upgrade once per minute;
- optional managed-environment probes exercise the complete edge-to-FRPS-to-T3
  route;
- relay maintenance emits a bounded five-minute outcome record;
- monitor failure and recovery transitions can be delivered to a self-hosted
  webhook receiver.

The monitor publishes no port and holds no account, relay, environment, or
database credential. It logs fixed check names and fixed failure codes; it does
not log URLs, hostnames, headers, tokens, request bodies, or query strings.

## Coolify configuration

The `monitor` service is part of `t3-control`; it is not a fourth Coolify
resource and needs no domain. The split production Compose file starts it
unconditionally after account, relay, and FRPS.

Set these optional `t3-control` variables:

```ini
T3_MONITOR_MANAGED_HOSTS=prod-example.connect.moondiner.com
T3_MONITOR_ALERT_WEBHOOK_URL=https://alerts.internal.example/t3-sovereign
```

`T3_MONITOR_MANAGED_HOSTS` is a comma-separated list. Every entry must be a
direct child of `connect.moondiner.com`; arbitrary targets are rejected. Leave
it empty if no environment is required to remain continuously online. Update
it after an intentional account transfer if the managed hostname changes.

`T3_MONITOR_ALERT_WEBHOOK_URL` is optional. It may use HTTPS or private HTTP,
but must not contain user information, a password, or a query string. The
receiver gets JSON only when state first becomes failed and when it later
recovers:

```json
{
  "event": "sovereign_monitor_failed",
  "checkedAt": "2026-08-08T17:00:00.000Z",
  "ok": false,
  "checks": [
    { "name": "code_health", "ok": true },
    {
      "name": "connect_websocket",
      "ok": false,
      "reason": "websocket_upgrade_rejected"
    }
  ]
}
```

Without a webhook, the monitor still writes transition/heartbeat JSON to its
local container log. One failed probe is logged as pending; two consecutive
failed one-minute probes commit the failed state, and Docker becomes unhealthy
after the last successful probe is older than three minutes. This is visible in
Coolify, but it is not an out-of-band alert. Public exposure should not be
considered fully monitored until either a self-hosted receiver consumes the
webhook or Coolify itself is configured to notify an operator through an
accepted channel.

## Signals and interpretation

| Check                     | What it proves                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| `code_health`             | Edge, second proxy, Traefik, and hosted web are serving the build     |
| `account_health`          | Full proxy path and a successful account PostgreSQL query             |
| `relay_health`            | Full proxy path and a successful relay PostgreSQL query               |
| `connect_websocket`       | TLS/SNI, both Nginx tiers, Traefik, and FRPS control upgrade work     |
| `managed_environment_N`   | The route returns a real public T3 environment descriptor             |
| relay maintenance outcome | DPoP/activity cleanup ran and orphan deprovisioning completed/retried |

The WebSocket check validates the RFC 6455 accept value, not merely status 101. Managed environment names never appear in the emitted result; they are
represented by stable ordinal check names.

## Inspect locally

On the Coolify deployment host:

```bash
monitor_id="$(
  docker ps -q \
    --filter 'label=com.docker.compose.service=monitor'
)"

docker inspect "$monitor_id" \
  --format 'state={{.State.Status}} health={{.State.Health.Status}}'

docker logs --timestamps --tail 50 "$monitor_id"
```

Require exactly one monitor container before using these commands in an
automation. A normal heartbeat is emitted every five minutes. The first failed
one-minute probe is logged as pending, the second consecutive failure alerts,
and repeated failures do not spam the webhook.

Relay maintenance records are available from the relay container:

```bash
relay_id="$(
  docker ps -q \
    --filter 'label=com.docker.compose.service=relay'
)"

docker logs --timestamps --since 15m "$relay_id" 2>&1 |
  grep 'Relay maintenance completed'
```

The record contains cleanup outcome names and counts only. A failed cleanup is
retried by the next five-minute reconciliation pass.

## Validation after deployment

1. Require account, relay, FRPS, web, and monitor to be present exactly once.
2. Confirm the monitor becomes healthy and emits a successful heartbeat.
3. If a managed hostname is configured, confirm its ordinal check is healthy.
4. Send a synthetic test payload directly to the self-hosted receiver and
   verify its operator notification path.
5. During a controlled FRPS restart, require one failure transition followed
   by one recovery transition and no repeated webhook flood.

Run the component test only in a deployment-free window and follow
[`sovereign-failure-recovery.md`](./sovereign-failure-recovery.md).
