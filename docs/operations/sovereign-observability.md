# Sovereign observability and alerts

The sovereign deployment owns its telemetry end to end. Grafana is the single
operator UI, Prometheus stores metrics, Loki stores container logs, Tempo stores
traces, and OpenTelemetry Collectors move signals between isolated Coolify
resources. No Axiom, Clerk, Expo, or other hosted telemetry service is used.

This is a single-host production layout. It gives complete signal coverage and
bounded retention without adding Kafka or an external object store. It is not
highly available: losing the Coolify host also loses live observability until
the persisted volumes are restored. Move Loki and Tempo to an S3-compatible
object store before the retained telemetry becomes business-critical or trace
volume outgrows one host.

## What is measured

| Signal                                   | Source             | Operational question                                                            |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `t3_relay_connector_events_total`        | remote `t3-server` | How often did a connector disconnect, exit, recover, or get rejected?           |
| `t3_relay_connector_recovery_duration_*` | remote `t3-server` | How long was the environment unreachable?                                       |
| `t3_relay_connector_connected`           | remote `t3-server` | Does the client currently report a registered tunnel?                           |
| `t3_relay_frp_connector_events_total`    | relay FRPS plugin  | How many logins and changed-run reconnects did the relay observe?               |
| `t3_relay_frp_authorization_total`       | relay FRPS plugin  | Are credentials or routes being rejected?                                       |
| FRPS native metrics                      | FRPS `/metrics`    | Connections, traffic, proxies, and server-side tunnel state                     |
| `t3_sovereign_probe_*`                   | private monitor    | Do code, auth, relay, Connect, and selected environment routes work end to end? |
| `t3_rpc_*`, `t3_provider_*`, `t3_git_*`  | remote `t3-server` | Where does agent work spend time?                                               |
| node-exporter and cAdvisor               | observability host | Are CPU, memory, disk, network, or a container the bottleneck?                  |
| container stdout/stderr                  | Coolify log drain  | What happened around an alert or trace?                                         |

Connector IDs and hostnames are intentionally absent from metric labels. They
remain available in private logs and traces for drill-down without creating an
unbounded Prometheus series count.

## 1. Prepare DNS and the proxy chain

Create `observe.moondiner.com` at the same public ingress used by the other
sovereign names. The existing `*.moondiner.com` certificate covers it. Install
the versioned edge and second-proxy configurations before exposing the Coolify
resource:

```sh
sudo infra/sovereign/proxy/install-nginx-config.sh edge \
  infra/sovereign/proxy/edge.nginx.conf
sudo infra/sovereign/proxy/install-nginx-config.sh second \
  infra/sovereign/proxy/second.nginx.conf
```

Run those commands on their respective hosts, not from the repository machine.
Both installers test and roll back failed Nginx reloads. Then run
`infra/sovereign/proxy/check-drift.sh` from the administrator workstation.

## 2. Generate and retain secrets

Generate distinct values and put them in Coolify plus the encrypted offline
backup. Do not reuse the account or relay signing secrets.

```sh
openssl rand -hex 48 # T3_OTLP_INGEST_TOKEN
openssl rand -hex 48 # T3_LOKI_INGEST_TOKEN
openssl rand -hex 32 # T3_GRAFANA_ADMIN_PASSWORD
openssl rand -hex 48 # T3_GRAFANA_SECRET_KEY
```

The OTLP token is shared by the control collector and explicitly enrolled
remote environments. The Loki token exists only in the Coolify log-drain
configuration and the ingest gateway. Grafana credentials do not authorize
ingestion.

## 3. Create `t3-observability` in Coolify

Create a Docker Compose application from the private fork with:

- base directory `/`;
- Compose file `/infra/sovereign/compose.observability.yaml`;
- branch `sovereign/main`;
- gateway domain `https://observe.moondiner.com:8080`;
- health check path `/health` on the gateway;
- Include Source Commit in Build enabled.

Add these variables:

```ini
T3_OBSERVABILITY_URL=https://observe.moondiner.com
T3_OTLP_INGEST_TOKEN=<48-byte generated value>
T3_LOKI_INGEST_TOKEN=<different 48-byte generated value>
T3_LOKI_INGEST_BASIC_AUTH=<Basic plus base64 of coolify:the-Loki-token>
T3_GRAFANA_ADMIN_USER=admin
T3_GRAFANA_ADMIN_PASSWORD=<generated value>
T3_GRAFANA_SECRET_KEY=<generated value>
T3_ALERT_WEBHOOK_URL=https://alerts.internal.example/t3-sovereign
T3_PROMETHEUS_RETENTION=30d
T3_PROMETHEUS_RETENTION_SIZE=20GB
```

`T3_ALERT_WEBHOOK_URL` is optional and may be private HTTP or public HTTPS. It
must not carry credentials in its query string. The alert router always writes
the complete Alertmanager payload to its own container log and forwards it when
a destination is configured.

Named volumes retain Prometheus, Loki, Tempo, Grafana, and Alertmanager state.
Confirm Coolify shows all five before the first deploy. cAdvisor is deliberately
privileged and read-only mounts host Docker state; it is the one exception to
the stack's normal capability drop because per-container bottleneck data is not
available otherwise.

Deploy this resource first. The first successful checks are:

```sh
curl --fail https://observe.moondiner.com/health
curl --fail https://observe.moondiner.com/api/health
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST https://observe.moondiner.com/otlp/v1/metrics)" = 401
```

## 4. Connect `t3-control`

Add the same OTLP token to the existing `t3-control` Coolify resource:

```ini
T3_OBSERVABILITY_OTLP_ENDPOINT=https://observe.moondiner.com/otlp
T3_OTLP_INGEST_TOKEN=<same OTLP token as the gateway>
```

Redeploy `t3-control`. Its private collector now receives relay traces and
metrics, scrapes FRPS and monitor metrics, batches them, and exports through the
authenticated public endpoint. FRPS port `7500` and monitor port `4300` remain
Docker-private.

In Grafana, open **T3 Sovereign / T3 Sovereign Overview**. The end-to-end probe
panels should populate within a minute. Relay metrics populate when FRPS handles
the next login, heartbeat, proxy operation, or relay request.

## 5. Drain Coolify logs to Loki

On the Coolify server, open **Configuration → Log Drains → Custom Fluent Bit**.
Use the following configuration, replacing the token directly in Coolify's
sensitive configuration field:

```ini
[SERVICE]
    Flush        5
    Daemon       Off
    Log_Level    info

[INPUT]
    Name         forward
    Listen       0.0.0.0
    Port         24224

[OUTPUT]
    Name         loki
    Match        *
    Host         observe.moondiner.com
    Port         443
    TLS          On
    TLS.Verify   On
    URI          /loki/api/v1/push
    HTTP_User    coolify
    HTTP_Passwd  <T3_LOKI_INGEST_TOKEN>
    Labels       job=coolify
    Line_Format  json
    Compress     gzip
```

Enable Drain Logs on `t3-control`, `t3-web`, and the PostgreSQL resource, then
redeploy them so Docker receives the logging driver. Do not enable it on
`t3-observability`; sending Loki's own output back into Loki creates a noisy
feedback loop. Verify delivery in Grafana Explore with `{job="coolify"}`.

## 6. Enroll each remote `t3-server`

The generated Linux systemd unit reads
`~/.config/t3code/observability.env`. Runtime upgrades preserve this file. On
each remote environment, create it with mode `0600`:

```ini
T3CODE_OTLP_TRACES_URL=https://observe.moondiner.com/otlp/v1/traces
T3CODE_OTLP_METRICS_URL=https://observe.moondiner.com/otlp/v1/metrics
T3CODE_OTLP_AUTHORIZATION="Bearer <T3_OTLP_INGEST_TOKEN>"
T3CODE_OTLP_SERVICE_NAME=t3-server
T3CODE_OTLP_SERVICE_INSTANCE_ID=<stable-unique-environment-name>
T3CODE_OTLP_EXPORT_INTERVAL_MS=10000
```

Use a stable, unique instance value such as `workstation-robert` or the
environment UUID. Without it, multiple servers write the same Prometheus label
set and their samples can collide. Then run:

```sh
systemctl --user daemon-reload
systemctl --user restart t3code.service
systemctl --user status t3code.service --no-pager
```

Desktop-managed servers can use the same `T3CODE_OTLP_*` variables in the
desktop backend environment. The bearer token is an operator secret; never put
it in a checked-in `.env`, hosted discovery document, or web/mobile build.

## 7. Validate disconnect counting

In a deployment-free window, select one enrolled remote environment and restart
FRPS or briefly block only its FRPC transport. Do not kill processes by pattern.
The expected sequence is:

1. `event="transient_disconnect"` increases once;
2. `t3_relay_connector_connected` changes from `1` to `0`;
3. FRPC reconnects and `event="recovered"` increases once;
4. the recovery histogram records the outage duration;
5. relay-side `event="reconnect"` increases when FRPS observes a changed run ID;
6. logs around the same timestamp explain the transport error.

Useful PromQL:

```promql
sum(increase(t3_relay_connector_events_total{event="transient_disconnect"}[24h]))

sum by (service_instance_id) (
  increase(t3_relay_connector_events_total{event="transient_disconnect"}[24h])
)

histogram_quantile(
  0.95,
  sum by (le) (
    rate(t3_relay_connector_recovery_duration_milliseconds_bucket[15m])
  )
)
```

The client-side metric is the authoritative transient-disconnect count because
it sees transport loss and recovery even when FRPS cannot deliver `CloseProxy`.
The relay-side login/reconnect count is an independent corroborating signal.

## Alerts and retention

Prometheus provisions alerts for failed probes, connector flapping, prolonged
connector loss, credential rejection, host disk/memory pressure, and collector
export failures. Alertmanager groups duplicates and the alert router forwards
both firing and resolved notifications.

Defaults are 30 days for Prometheus, 30 days for Loki, and 14 days for Tempo.
Prometheus also stops at 20 GB and removes the oldest blocks. Loki retention is
time-based, not free-space-based, so the host disk alert is a required safety
boundary. Back up the named volumes or their host paths with the same rigor as
the rest of the sovereign state.

Scale beyond this layout when any of these remain true for a week:

- trace ingestion regularly exceeds one CPU core in Tempo;
- the collector queue or failed-export counters grow during normal operation;
- Loki or Prometheus uses more than half the disk budget before half its
  retention window;
- dashboard queries routinely exceed five seconds;
- observability must survive loss of the Coolify host.

At that point keep Grafana and the authenticated gateway, move Loki and Tempo
to object storage, and evaluate Mimir or Thanos for durable multi-node metrics.
Do not add that machinery preemptively to the current single-host deployment.
