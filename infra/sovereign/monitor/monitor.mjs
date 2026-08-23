import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeFailure";
    this.code = code;
  }
}

const parsePositiveInteger = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseHttpUrl = (value, name, { allowHttp = false } = {}) => {
  const url = new URL(value);
  const protocols = allowHttp ? ["http:", "https:"] : ["https:"];
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a query-free ${protocols.join(" or ")} URL`);
  }
  return url;
};

export const parseManagedHosts = (value, connectUrl) => {
  const baseDomain = connectUrl.hostname;
  const hostnamePattern = new RegExp(`^[a-z0-9-]+[.]${baseDomain.replaceAll(".", "[.]")}$`, "u");
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].map((hostname) => {
    if (!hostnamePattern.test(hostname)) {
      throw new Error(
        `T3_MONITOR_MANAGED_HOSTS entries must be one-label children of ${baseDomain}`,
      );
    }
    return hostname;
  });
};

export const loadMonitorConfiguration = (environment = process.env) => {
  const codeUrl = parseHttpUrl(
    environment.T3_MONITOR_CODE_URL ?? "https://code.moondiner.com",
    "T3_MONITOR_CODE_URL",
  );
  const accountUrl = parseHttpUrl(
    environment.T3_MONITOR_ACCOUNT_URL ?? "https://auth.moondiner.com",
    "T3_MONITOR_ACCOUNT_URL",
  );
  const relayUrl = parseHttpUrl(
    environment.T3_MONITOR_RELAY_URL ?? "https://relay.moondiner.com",
    "T3_MONITOR_RELAY_URL",
  );
  const connectUrl = parseHttpUrl(
    environment.T3_MONITOR_CONNECT_URL ?? "https://connect.moondiner.com",
    "T3_MONITOR_CONNECT_URL",
  );
  const alertWebhookUrl = environment.T3_MONITOR_ALERT_WEBHOOK_URL?.trim()
    ? parseHttpUrl(
        environment.T3_MONITOR_ALERT_WEBHOOK_URL.trim(),
        "T3_MONITOR_ALERT_WEBHOOK_URL",
        {
          allowHttp: true,
        },
      )
    : undefined;
  return {
    codeUrl,
    accountUrl,
    relayUrl,
    connectUrl,
    managedHosts: parseManagedHosts(environment.T3_MONITOR_MANAGED_HOSTS, connectUrl),
    alertWebhookUrl,
    intervalMs: parsePositiveInteger(
      environment.T3_MONITOR_INTERVAL_MS,
      60_000,
      "T3_MONITOR_INTERVAL_MS",
    ),
    timeoutMs: parsePositiveInteger(
      environment.T3_MONITOR_TIMEOUT_MS,
      10_000,
      "T3_MONITOR_TIMEOUT_MS",
    ),
    heartbeatMs: parsePositiveInteger(
      environment.T3_MONITOR_HEARTBEAT_MS,
      300_000,
      "T3_MONITOR_HEARTBEAT_MS",
    ),
    failureThreshold: parsePositiveInteger(
      environment.T3_MONITOR_FAILURE_THRESHOLD,
      2,
      "T3_MONITOR_FAILURE_THRESHOLD",
    ),
    healthStatePath:
      environment.T3_MONITOR_HEALTH_STATE_PATH?.trim() || "/tmp/t3-sovereign-monitor/healthy",
    metricsHost: environment.T3_MONITOR_METRICS_HOST?.trim() || "127.0.0.1",
    metricsPort: parsePositiveInteger(
      environment.T3_MONITOR_METRICS_PORT,
      4300,
      "T3_MONITOR_METRICS_PORT",
    ),
  };
};

const healthUrl = (baseUrl) => new URL("/health", baseUrl);

const checkJsonHealth = async (url, timeoutMs, fetchImplementation) => {
  let response;
  try {
    response = await fetchImplementation(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProbeFailure("request_failed");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ProbeFailure("unexpected_status");
  }
  const body = await response.json().catch(() => undefined);
  if (body?.ok !== true) {
    throw new ProbeFailure("invalid_health_body");
  }
};

const checkEnvironmentDescriptor = async (hostname, timeoutMs, fetchImplementation) => {
  let response;
  try {
    response = await fetchImplementation(
      new URL("/.well-known/t3/environment", `https://${hostname}`),
      {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw new ProbeFailure("request_failed");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ProbeFailure("unexpected_status");
  }
  const body = await response.json().catch(() => undefined);
  if (typeof body?.environmentId !== "string" || body.environmentId.length === 0) {
    throw new ProbeFailure("invalid_environment_descriptor");
  }
};

export const checkConnectWebSocket = (connectUrl, timeoutMs) =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    const request = httpsRequest(new URL("/~!frp", connectUrl), {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: connectUrl.origin,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
      timeout: timeoutMs,
    });
    request.once("upgrade", (response, socket) => {
      const accept = response.headers["sec-websocket-accept"];
      const connection = String(response.headers.connection ?? "");
      const upgrade = String(response.headers.upgrade ?? "");
      socket.destroy();
      if (
        response.statusCode !== 101 ||
        !/upgrade/iu.test(connection) ||
        !/^websocket$/iu.test(upgrade) ||
        accept !== expectedAccept
      ) {
        reject(new ProbeFailure("invalid_websocket_upgrade"));
        return;
      }
      resolve();
    });
    request.once("response", (response) => {
      response.resume();
      reject(new ProbeFailure("websocket_upgrade_rejected"));
    });
    request.once("timeout", () => request.destroy(new ProbeFailure("request_timeout")));
    request.once("error", () => reject(new ProbeFailure("request_failed")));
    request.end();
  });

const resultFor = async (name, operation, onResult) => {
  const startedAt = performance.now();
  try {
    await operation();
    const result = { name, ok: true };
    onResult?.(result, Math.max(0, performance.now() - startedAt) / 1000);
    return result;
  } catch (error) {
    const result = {
      name,
      ok: false,
      reason: error instanceof ProbeFailure ? error.code : "request_failed",
    };
    onResult?.(result, Math.max(0, performance.now() - startedAt) / 1000);
    return result;
  }
};

export const runProbe = async (
  configuration,
  { fetchImplementation = fetch, websocketCheck = checkConnectWebSocket, onCheckResult } = {},
) => {
  const checks = await Promise.all([
    resultFor(
      "code_health",
      () =>
        checkJsonHealth(
          healthUrl(configuration.codeUrl),
          configuration.timeoutMs,
          fetchImplementation,
        ),
      onCheckResult,
    ),
    resultFor(
      "account_health",
      () =>
        checkJsonHealth(
          healthUrl(configuration.accountUrl),
          configuration.timeoutMs,
          fetchImplementation,
        ),
      onCheckResult,
    ),
    resultFor(
      "relay_health",
      () =>
        checkJsonHealth(
          healthUrl(configuration.relayUrl),
          configuration.timeoutMs,
          fetchImplementation,
        ),
      onCheckResult,
    ),
    resultFor(
      "connect_websocket",
      () => websocketCheck(configuration.connectUrl, configuration.timeoutMs),
      onCheckResult,
    ),
    ...configuration.managedHosts.map((hostname, index) =>
      resultFor(
        `managed_environment_${index + 1}`,
        () => checkEnvironmentDescriptor(hostname, configuration.timeoutMs, fetchImplementation),
        onCheckResult,
      ),
    ),
  ]);
  return { ok: checks.every((check) => check.ok), checks };
};

export const transitionFor = (previousOk, currentOk) => {
  if (!currentOk && previousOk !== false) return "failed";
  if (currentOk && previousOk === false) return "recovered";
  return undefined;
};

export const committedStateFor = (
  previousOk,
  currentProbeOk,
  consecutiveFailures,
  failureThreshold,
) => {
  if (currentProbeOk) return true;
  if (consecutiveFailures >= failureThreshold) return false;
  return previousOk;
};

const updateHealthState = async (path, healthy, checkedAt) => {
  if (healthy) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${checkedAt}\n`, { mode: 0o600 });
    return;
  }
  await rm(path, { force: true });
};

const deliverAlert = async (url, payload, timeoutMs) => {
  if (!url) return;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  if (!response.ok) throw new ProbeFailure("alert_delivery_rejected");
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const prometheusLabel = (value) =>
  String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

export const createMonitorMetrics = () => {
  const checks = new Map();
  const failures = new Map();
  const transitions = new Map();
  let consecutiveFailures = 0;
  let committedState;

  return {
    recordCheck(result, durationSeconds) {
      checks.set(result.name, { ok: result.ok, durationSeconds });
      if (!result.ok) {
        const key = `${result.name}\u0000${result.reason}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    },
    recordProbe(input) {
      consecutiveFailures = input.consecutiveFailures;
      committedState = input.committedState;
      if (input.transition) {
        transitions.set(input.transition, (transitions.get(input.transition) ?? 0) + 1);
      }
    },
    render() {
      const lines = [
        "# HELP t3_sovereign_probe_success Whether the latest active probe check succeeded.",
        "# TYPE t3_sovereign_probe_success gauge",
      ];
      for (const [name, value] of checks) {
        const check = prometheusLabel(name);
        lines.push(`t3_sovereign_probe_success{check="${check}"} ${value.ok ? 1 : 0}`);
      }
      lines.push(
        "# HELP t3_sovereign_probe_duration_seconds Duration of the latest active probe check.",
        "# TYPE t3_sovereign_probe_duration_seconds gauge",
      );
      for (const [name, value] of checks) {
        lines.push(
          `t3_sovereign_probe_duration_seconds{check="${prometheusLabel(name)}"} ${value.durationSeconds}`,
        );
      }
      lines.push(
        "# HELP t3_sovereign_probe_failures_total Active probe failures by bounded reason.",
        "# TYPE t3_sovereign_probe_failures_total counter",
      );
      for (const [key, count] of failures) {
        const [name, reason] = key.split("\u0000");
        lines.push(
          `t3_sovereign_probe_failures_total{check="${prometheusLabel(name)}",reason="${prometheusLabel(reason)}"} ${count}`,
        );
      }
      lines.push(
        "# HELP t3_sovereign_monitor_consecutive_failures Consecutive failed probe runs.",
        "# TYPE t3_sovereign_monitor_consecutive_failures gauge",
        `t3_sovereign_monitor_consecutive_failures ${consecutiveFailures}`,
        "# HELP t3_sovereign_monitor_healthy Committed monitor state; -1 means not yet committed.",
        "# TYPE t3_sovereign_monitor_healthy gauge",
        `t3_sovereign_monitor_healthy ${committedState === undefined ? -1 : committedState ? 1 : 0}`,
        "# HELP t3_sovereign_monitor_transitions_total Committed failed and recovered transitions.",
        "# TYPE t3_sovereign_monitor_transitions_total counter",
      );
      for (const transition of ["failed", "recovered"]) {
        lines.push(
          `t3_sovereign_monitor_transitions_total{transition="${transition}"} ${transitions.get(transition) ?? 0}`,
        );
      }
      return `${lines.join("\n")}\n`;
    },
  };
};

export const startMetricsServer = (configuration, metrics) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok\n");
      return;
    }
    if (request.method === "GET" && request.url === "/metrics") {
      response
        .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
        .end(metrics.render());
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(configuration.metricsPort, configuration.metricsHost);
  return server;
};

export const runMonitor = async (configuration, { metrics = createMonitorMetrics() } = {}) => {
  let previousOk;
  let consecutiveFailures = 0;
  let lastHeartbeatAt = 0;
  while (true) {
    const checkedAt = new Date().toISOString();
    const result = await runProbe(configuration, {
      onCheckResult: (check, durationSeconds) => metrics.recordCheck(check, durationSeconds),
    });
    consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
    const committedState = committedStateFor(
      previousOk,
      result.ok,
      consecutiveFailures,
      configuration.failureThreshold,
    );
    if (committedState !== undefined) {
      await updateHealthState(configuration.healthStatePath, committedState, checkedAt);
    }
    const transition =
      committedState === undefined ? undefined : transitionFor(previousOk, committedState);
    metrics.recordProbe({ consecutiveFailures, committedState, transition });
    const now = Date.now();
    const pendingFailure = !result.ok && committedState !== false;
    if (transition || pendingFailure || now - lastHeartbeatAt >= configuration.heartbeatMs) {
      console.log(
        JSON.stringify({
          event: transition
            ? `sovereign_monitor_${transition}`
            : pendingFailure
              ? "sovereign_monitor_failure_pending"
              : "sovereign_monitor_heartbeat",
          checkedAt,
          ok: result.ok,
          consecutiveFailures,
          checks: result.checks,
        }),
      );
      lastHeartbeatAt = now;
    }
    if (transition) {
      try {
        await deliverAlert(
          configuration.alertWebhookUrl,
          {
            event: `sovereign_monitor_${transition}`,
            checkedAt,
            ok: result.ok,
            checks: result.checks,
          },
          configuration.timeoutMs,
        );
      } catch {
        console.error(
          JSON.stringify({
            event: "sovereign_monitor_alert_delivery_failed",
            checkedAt,
          }),
        );
      }
    }
    previousOk = committedState;
    await sleep(configuration.intervalMs);
  }
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const configuration = loadMonitorConfiguration();
  const metrics = createMonitorMetrics();
  startMetricsServer(configuration, metrics);
  runMonitor(configuration, { metrics }).catch((error) => {
    console.error(
      JSON.stringify({
        event: "sovereign_monitor_crashed",
        reason: error instanceof Error ? error.message : "unknown_failure",
      }),
    );
    process.exitCode = 1;
  });
}
