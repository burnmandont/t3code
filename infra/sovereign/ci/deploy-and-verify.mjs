import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import * as NodeURL from "node:url";

const COOLIFY_POLL_INTERVAL_MS = 15_000;
const COOLIFY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DEPLOY_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_DEPLOY_MAX_ATTEMPTS = 2;
const DEFAULT_DEPLOY_RETRY_DELAY_MS = 10_000;
const HEALTH_ATTEMPTS = 12;
const HEALTH_RETRY_INTERVAL_MS = 5_000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requiredEnvironmentValue = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const compactResponseBody = (value) => {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length > 500 ? `${rendered.slice(0, 500)}…` : rendered;
};

export const classifyDeploymentStatus = (status) => {
  switch (status) {
    case "queued":
    case "in_progress":
      return "pending";
    case "finished":
      return "success";
    case "failed":
    case "cancelled-by-user":
      return "failure";
    default:
      throw new Error(`Coolify returned an unknown deployment status: ${String(status)}`);
  }
};

export class CoolifyDeploymentTerminalError extends Error {
  constructor({ deploymentUuid, resourceUuid, status }) {
    super(`Coolify deployment ${deploymentUuid} for ${resourceUuid} ended with ${status}`);
    this.name = "CoolifyDeploymentTerminalError";
    this.deploymentUuid = deploymentUuid;
    this.resourceUuid = resourceUuid;
    this.status = status;
  }
}

class CoolifyResponseError extends Error {
  constructor(status, body) {
    super(`Coolify API request failed (${status}): ${compactResponseBody(body)}`);
    this.name = "CoolifyResponseError";
    this.status = status;
  }
}

const coolifyJson = async (url, token, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CoolifyResponseError(response.status, body);
  }
  return body;
};

export const waitForDeployment = async ({
  deploymentUuid,
  resourceUuid,
  getDeployment,
  timeoutMs = DEFAULT_DEPLOY_TIMEOUT_MS,
  pollIntervalMs = COOLIFY_POLL_INTERVAL_MS,
  sleepFn = sleep,
  now = Date.now,
  onStatus = () => {},
}) => {
  const deadline = now() + timeoutMs;
  let previousStatus;
  let consecutiveRequestFailures = 0;

  while (now() < deadline) {
    try {
      const deployment = await getDeployment(deploymentUuid);
      consecutiveRequestFailures = 0;
      const status = deployment?.status;
      const classification = classifyDeploymentStatus(status);

      if (status !== previousStatus) {
        onStatus(status);
        previousStatus = status;
      }
      if (classification === "success") {
        return deployment;
      }
      if (classification === "failure") {
        throw new CoolifyDeploymentTerminalError({
          deploymentUuid,
          resourceUuid,
          status,
        });
      }
    } catch (error) {
      if (
        error instanceof CoolifyDeploymentTerminalError ||
        (error instanceof Error && error.message.includes("unknown deployment status"))
      ) {
        throw error;
      }
      consecutiveRequestFailures += 1;
      if (consecutiveRequestFailures >= 4) {
        throw new Error(
          `Could not read Coolify deployment ${deploymentUuid} after ${consecutiveRequestFailures} attempts`,
          { cause: error },
        );
      }
      onStatus(`status request failed; retry ${consecutiveRequestFailures}/3`);
    }

    await sleepFn(pollIntervalMs);
  }

  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for Coolify deployment ${deploymentUuid} (${resourceUuid})`,
  );
};

const validateQueuedDeployments = (resourceUuids, deployments) => {
  if (!Array.isArray(deployments)) {
    throw new Error("Coolify deployment response did not contain a deployments array");
  }
  const requested = new Set(resourceUuids);
  const byResource = new Map();
  for (const deployment of deployments) {
    const deploymentUuid = deployment?.deployment_uuid;
    const resourceUuid = deployment?.resource_uuid;
    if (typeof deploymentUuid !== "string" || typeof resourceUuid !== "string") {
      throw new Error("Coolify returned a deployment without string UUIDs");
    }
    if (!requested.has(resourceUuid)) {
      throw new Error(`Coolify returned an unexpected resource: ${resourceUuid}`);
    }
    if (byResource.has(resourceUuid)) {
      throw new Error(`Coolify returned duplicate deployments for resource: ${resourceUuid}`);
    }
    byResource.set(resourceUuid, deployment);
  }
  const missing = resourceUuids.filter((uuid) => !byResource.has(uuid));
  if (missing.length > 0) {
    throw new Error(`Coolify did not accept every resource: ${missing.join(", ")}`);
  }
  return resourceUuids.map((uuid) => byResource.get(uuid));
};

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export const deployResourcesWithRetry = async ({
  resourceUuids,
  queueDeployments,
  waitForQueuedDeployment,
  maxAttempts = DEFAULT_DEPLOY_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_DEPLOY_RETRY_DELAY_MS,
  sleepFn = sleep,
  onRetry = () => {},
}) => {
  let pendingResourceUuids = [...resourceUuids];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const deployments = validateQueuedDeployments(
      pendingResourceUuids,
      await queueDeployments(pendingResourceUuids),
    );
    const results = await Promise.allSettled(
      deployments.map((deployment) => waitForQueuedDeployment(deployment, attempt)),
    );
    const retryable = [];
    const terminal = [];

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      const resourceUuid = deployments[index].resource_uuid;
      if (
        attempt < maxAttempts &&
        result.reason instanceof CoolifyDeploymentTerminalError &&
        result.reason.status === "failed"
      ) {
        retryable.push(resourceUuid);
        continue;
      }
      terminal.push({ resourceUuid, error: result.reason });
    }

    if (terminal.length > 0) {
      throw new Error(
        `Coolify deployment failed: ${terminal
          .map(({ resourceUuid, error }) => `${resourceUuid}: ${errorMessage(error)}`)
          .join("; ")}`,
        { cause: terminal[0].error },
      );
    }
    if (retryable.length === 0) return;

    pendingResourceUuids = retryable;
    onRetry({ attempt: attempt + 1, maxAttempts, resourceUuids: retryable });
    await sleepFn(retryDelayMs);
  }
};

export const validateEdgeSecurityHeaders = (headers, label) => {
  const required = [
    ["strict-transport-security", /(?:^|;)\s*max-age=\d+/iu],
    ["x-content-type-options", /^nosniff$/iu],
    ["x-frame-options", /^DENY$/iu],
    ["referrer-policy", /^no-referrer$/iu],
  ];
  for (const [name, expected] of required) {
    const value = headers.get(name) ?? "";
    const values = value.split(",").map((part) => part.trim());
    if (values.length === 0 || values.some((part) => !expected.test(part))) {
      throw new Error(`${label} is missing a valid ${name} header`);
    }
  }
};

export const validateWebContentSecurityPolicy = (headers) => {
  const policy = headers.get("content-security-policy") ?? "";
  const requiredDirectives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src-attr 'none'",
    "connect-src 'self' https: wss:",
  ];
  for (const directive of requiredDirectives) {
    if (!policy.includes(directive)) {
      throw new Error(`Hosted web CSP is missing ${directive}`);
    }
  }
};

const fetchJson = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => undefined);
  return { response, body };
};

const checkHealthEndpoint = async (url, { validateWebPolicy = false } = {}) => {
  const { response, body } = await fetchJson(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  if (response.status !== 200 || body?.ok !== true) {
    throw new Error(`${url} returned ${response.status} without {"ok":true}`);
  }
  validateEdgeSecurityHeaders(response.headers, url);
  if (validateWebPolicy) {
    validateWebContentSecurityPolicy(response.headers);
  }
};

const checkOauthMetadata = async () => {
  const issuer = "https://auth.moondiner.com/api/auth";
  const { response, body } = await fetchJson(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200 || body?.issuer !== issuer) {
    throw new Error("OAuth discovery did not return the exact sovereign issuer");
  }
  validateEdgeSecurityHeaders(response.headers, "OAuth discovery");

  const jwks = await fetchJson(`${issuer}/jwks`, {
    headers: { Accept: "application/json" },
  });
  if (
    jwks.response.status !== 200 ||
    !Array.isArray(jwks.body?.keys) ||
    jwks.body.keys.length === 0 ||
    jwks.body.keys.some((key) => typeof key !== "object" || key === null || "d" in key)
  ) {
    throw new Error("OAuth JWKS is unavailable, empty, or exposes private key material");
  }
  validateEdgeSecurityHeaders(jwks.response.headers, "OAuth JWKS");
};

const checkControlPlaneDiscovery = async () => {
  const runtimeVersion = requiredEnvironmentValue("SOVEREIGN_RUNTIME_VERSION");
  const { response, body } = await fetchJson(
    "https://code.moondiner.com/.well-known/t3-sovereign.json",
    { headers: { Accept: "application/json", "Cache-Control": "no-cache" } },
  );
  const expected = {
    schemaVersion: 1,
    runtimeVersion,
    origin: "https://code.moondiner.com",
    hostedAppUrl: "https://code.moondiner.com",
    oauthIssuer: "https://auth.moondiner.com/api/auth",
    oauthClientId: "t3-code",
    oauthResource: "https://relay.moondiner.com",
    relayUrl: "https://relay.moondiner.com",
  };
  if (
    response.status !== 200 ||
    typeof body !== "object" ||
    body === null ||
    Object.keys(body).length !== Object.keys(expected).length ||
    !Object.entries(expected).every(([key, value]) => body[key] === value)
  ) {
    throw new Error("Hosted control-plane discovery does not match the deployed sovereign stack");
  }
  validateEdgeSecurityHeaders(response.headers, "Control-plane discovery");
};

const checkRelayRejectsInvalidBearer = async () => {
  const response = await fetch("https://relay.moondiner.com/v1/environments", {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer sovereign-ci-invalid-token",
    },
    redirect: "error",
    signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 401) {
    throw new Error(`Relay accepted an invalid bearer with status ${response.status}`);
  }
  validateEdgeSecurityHeaders(response.headers, "Relay authentication boundary");
};

const checkResponseStatus = async (url, expectedStatus, label, init = {}) => {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}; expected ${expectedStatus}`);
  }
  validateEdgeSecurityHeaders(response.headers, label);
  return response;
};

const checkPublicRouteBoundary = async () => {
  await Promise.all([
    checkResponseStatus("https://connect.moondiner.com/", 404, "Connect apex"),
    checkResponseStatus(
      "https://connect.moondiner.com/~!frp",
      426,
      "Connect non-WebSocket request",
    ),
    checkResponseStatus("https://relay.moondiner.com/docs", 404, "Relay documentation"),
    checkResponseStatus("https://relay.moondiner.com/openapi.json", 404, "Relay OpenAPI"),
  ]);

  const relayCors = await fetch("https://relay.moondiner.com/health", {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.invalid",
      "Access-Control-Request-Method": "GET",
    },
    redirect: "error",
    signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
  });
  await relayCors.body?.cancel();
  if (relayCors.headers.has("access-control-allow-origin")) {
    throw new Error("Relay granted CORS to an untrusted origin");
  }

  for (const origin of ["https://code.moondiner.com", "t3code://app", "t3code-dev://app"]) {
    const allowedRelayCors = await fetch("https://relay.moondiner.com/v1/environments", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,dpop",
      },
      redirect: "error",
      signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
    });
    await allowedRelayCors.body?.cancel();
    if (allowedRelayCors.headers.get("access-control-allow-origin") !== origin) {
      throw new Error(`Relay did not grant CORS to the trusted client origin ${origin}`);
    }
  }

  const accountCors = await fetch("https://auth.moondiner.com/api/auth/session", {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.invalid",
      "Access-Control-Request-Method": "GET",
    },
    redirect: "error",
    signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
  });
  await accountCors.body?.cancel();
  if (accountCors.status !== 403 || accountCors.headers.has("access-control-allow-origin")) {
    throw new Error(
      `Account CORS boundary returned ${accountCors.status} or granted an untrusted origin`,
    );
  }
};

export const unexpectedHostRequestOptions = () => ({
  hostname: "code.moondiner.com",
  servername: "code.moondiner.com",
  port: 443,
  path: "/",
  method: "GET",
  headers: { Host: "attacker.invalid" },
  timeout: COOLIFY_REQUEST_TIMEOUT_MS,
});

const checkUnexpectedHostRejected = () =>
  new Promise((resolve, reject) => {
    const request = NodeHttps.request(unexpectedHostRequestOptions());
    request.once("response", (response) => {
      response.resume();
      if (response.statusCode !== 421) {
        reject(new Error(`Unexpected Host request returned ${response.statusCode}; expected 421`));
        return;
      }
      resolve();
    });
    request.once("timeout", () => request.destroy(new Error("Host rejection request timed out")));
    request.once("error", reject);
    request.end();
  });

export const expectedWebSocketAccept = (key) =>
  NodeCrypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

const checkConnectWebSocket = () =>
  new Promise((resolve, reject) => {
    const key = NodeCrypto.randomBytes(16).toString("base64");
    const request = NodeHttps.request({
      hostname: "connect.moondiner.com",
      port: 443,
      path: "/~!frp",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: "https://connect.moondiner.com",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
      timeout: COOLIFY_REQUEST_TIMEOUT_MS,
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
        accept !== expectedWebSocketAccept(key)
      ) {
        reject(new Error("Connect returned an invalid WebSocket upgrade response"));
        return;
      }
      validateEdgeSecurityHeaders(new Headers(response.headers), "Connect WebSocket");
      resolve();
    });
    request.once("response", (response) => {
      response.resume();
      reject(new Error(`Connect WebSocket upgrade returned ${response.statusCode}`));
    });
    request.once("timeout", () => request.destroy(new Error("Connect WebSocket timed out")));
    request.once("error", reject);
    request.end();
  });

const checkConnectRejectsUnexpectedOrigin = () =>
  new Promise((resolve, reject) => {
    const key = NodeCrypto.randomBytes(16).toString("base64");
    const request = NodeHttps.request({
      hostname: "connect.moondiner.com",
      port: 443,
      path: "/~!frp",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: "https://connect.moondiner.com.attacker.invalid",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
      timeout: COOLIFY_REQUEST_TIMEOUT_MS,
    });

    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Connect upgraded a WebSocket from an unexpected Origin"));
    });
    request.once("response", (response) => {
      response.resume();
      if (response.statusCode !== 403) {
        reject(new Error(`Connect unexpected-Origin request returned ${response.statusCode}`));
        return;
      }
      validateEdgeSecurityHeaders(new Headers(response.headers), "Connect Origin boundary");
      resolve();
    });
    request.once("timeout", () =>
      request.destroy(new Error("Connect Origin-boundary request timed out")),
    );
    request.once("error", reject);
    request.end();
  });

const checkObservabilityBoundary = async () => {
  const health = await fetchJson("https://observe.moondiner.com/api/health", {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
  });
  if (health.response.status !== 200 || health.body?.database !== "ok") {
    throw new Error("Grafana observability health is unavailable");
  }
  validateEdgeSecurityHeaders(health.response.headers, "Observability health");

  for (const path of ["/otlp/v1/traces", "/otlp/v1/metrics", "/loki/api/v1/push"]) {
    const response = await fetch(`https://observe.moondiner.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(COOLIFY_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status !== 401) {
      throw new Error(`Unauthenticated observability ingest ${path} returned ${response.status}`);
    }
    validateEdgeSecurityHeaders(response.headers, `Observability ingest ${path}`);
  }
};

export const verifyProduction = async () => {
  let lastError;
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      await Promise.all([
        checkHealthEndpoint("https://code.moondiner.com/health", {
          validateWebPolicy: true,
        }),
        checkHealthEndpoint("https://auth.moondiner.com/health"),
        checkHealthEndpoint("https://relay.moondiner.com/health"),
        checkOauthMetadata(),
        checkControlPlaneDiscovery(),
        checkRelayRejectsInvalidBearer(),
        checkPublicRouteBoundary(),
        checkUnexpectedHostRejected(),
        checkConnectWebSocket(),
        checkConnectRejectsUnexpectedOrigin(),
        checkObservabilityBoundary(),
      ]);
      console.log(
        "Production health, observability, authentication, route boundaries, TLS headers, and Connect WSS passed",
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === HEALTH_ATTEMPTS) {
        break;
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.log(
        `Production verification attempt ${attempt}/${HEALTH_ATTEMPTS} failed: ${reason}; retrying`,
      );
      await sleep(HEALTH_RETRY_INTERVAL_MS);
    }
  }
  throw new Error("Production verification did not become healthy", {
    cause: lastError,
  });
};

const main = async () => {
  const baseUrl = requiredEnvironmentValue("COOLIFY_URL").replace(/\/$/u, "");
  const token = requiredEnvironmentValue("COOLIFY_TOKEN");
  const observabilityUuid = requiredEnvironmentValue("COOLIFY_OBSERVABILITY_UUID");
  const applicationUuids = [
    observabilityUuid,
    requiredEnvironmentValue("COOLIFY_CONTROL_UUID"),
    requiredEnvironmentValue("COOLIFY_WEB_UUID"),
  ];
  const resourceUuids = applicationUuids.slice(1);
  if (new Set(applicationUuids).size !== applicationUuids.length) {
    throw new Error("Coolify observability, control, and web resource UUIDs must be different");
  }

  const timeoutMs = Number(process.env.COOLIFY_DEPLOY_TIMEOUT_MS ?? DEFAULT_DEPLOY_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
    throw new Error("COOLIFY_DEPLOY_TIMEOUT_MS must be an integer of at least 60000");
  }
  const maxAttempts = Number(
    process.env.COOLIFY_DEPLOY_MAX_ATTEMPTS ?? DEFAULT_DEPLOY_MAX_ATTEMPTS,
  );
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("COOLIFY_DEPLOY_MAX_ATTEMPTS must be an integer between 1 and 3");
  }
  const retryDelayMs = Number(
    process.env.COOLIFY_DEPLOY_RETRY_DELAY_MS ?? DEFAULT_DEPLOY_RETRY_DELAY_MS,
  );
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
    throw new Error("COOLIFY_DEPLOY_RETRY_DELAY_MS must be an integer between 0 and 60000");
  }

  const queueDeployments = async (uuids) => {
    const deployUrl = new URL(`${baseUrl}/api/v1/deploy`);
    deployUrl.searchParams.set("uuid", uuids.join(","));
    const body = await coolifyJson(deployUrl, token, { method: "POST" });
    return body.deployments;
  };
  const waitForQueuedDeployment = async (deployment, attempt) => {
    const deploymentUuid = deployment.deployment_uuid;
    const resourceUuid = deployment.resource_uuid;
    console.log(`Queued ${resourceUuid}: ${deploymentUuid} (attempt ${attempt}/${maxAttempts})`);
    await waitForDeployment({
      deploymentUuid,
      resourceUuid,
      timeoutMs,
      getDeployment: (uuid) =>
        coolifyJson(`${baseUrl}/api/v1/deployments/${encodeURIComponent(uuid)}`, token),
      onStatus: (status) => console.log(`${resourceUuid} (${deploymentUuid}): ${status}`),
    });
  };
  const onRetry = ({ attempt, maxAttempts: attempts, resourceUuids: retryUuids }) =>
    console.log(
      `Retrying failed Coolify resources after ${retryDelayMs}ms (attempt ${attempt}/${attempts}): ${retryUuids.join(", ")}`,
    );

  // The control-plane collector exports into this resource, so deploy and
  // confirm the telemetry destination before restarting relay or FRPS.
  await deployResourcesWithRetry({
    resourceUuids: [observabilityUuid],
    maxAttempts,
    retryDelayMs,
    queueDeployments,
    waitForQueuedDeployment,
    onRetry,
  });

  await deployResourcesWithRetry({
    resourceUuids,
    maxAttempts,
    retryDelayMs,
    queueDeployments,
    waitForQueuedDeployment,
    onRetry,
  });

  await verifyProduction();
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === NodeURL.pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause instanceof Error) {
      console.error(`Caused by: ${error.cause.message}`);
    }
    process.exitCode = 1;
  });
}
