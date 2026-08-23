import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

const COOLIFY_POLL_INTERVAL_MS = 15_000;
const COOLIFY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DEPLOY_TIMEOUT_MS = 20 * 60_000;
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
        throw new Error(
          `Coolify deployment ${deploymentUuid} for ${resourceUuid} ended with ${status}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("ended with") ||
          error.message.includes("unknown deployment status"))
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
    const request = httpsRequest(unexpectedHostRequestOptions());
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
  createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

const checkConnectWebSocket = () =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const request = httpsRequest({
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

export const verifyProduction = async () => {
  let lastError;
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      await Promise.all([
        checkHealthEndpoint("https://code.moondiner.com/health", { validateWebPolicy: true }),
        checkHealthEndpoint("https://auth.moondiner.com/health"),
        checkHealthEndpoint("https://relay.moondiner.com/health"),
        checkOauthMetadata(),
        checkRelayRejectsInvalidBearer(),
        checkPublicRouteBoundary(),
        checkUnexpectedHostRejected(),
        checkConnectWebSocket(),
      ]);
      console.log(
        "Production health, authentication, CORS, route boundaries, TLS headers, and Connect WSS passed",
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
  throw new Error("Production verification did not become healthy", { cause: lastError });
};

const main = async () => {
  const baseUrl = requiredEnvironmentValue("COOLIFY_URL").replace(/\/$/u, "");
  const token = requiredEnvironmentValue("COOLIFY_TOKEN");
  const resourceUuids = [
    requiredEnvironmentValue("COOLIFY_CONTROL_UUID"),
    requiredEnvironmentValue("COOLIFY_WEB_UUID"),
  ];
  if (new Set(resourceUuids).size !== resourceUuids.length) {
    throw new Error("Coolify control and web resource UUIDs must be different");
  }

  const deployUrl = new URL(`${baseUrl}/api/v1/deploy`);
  deployUrl.searchParams.set("uuid", resourceUuids.join(","));
  const body = await coolifyJson(deployUrl, token, { method: "POST" });
  const deployments = Array.isArray(body.deployments) ? body.deployments : [];
  const accepted = new Set(deployments.map((deployment) => deployment.resource_uuid));
  const missing = resourceUuids.filter((uuid) => !accepted.has(uuid));
  if (missing.length > 0) {
    throw new Error(`Coolify did not accept every resource: ${missing.join(", ")}`);
  }

  const timeoutMs = Number(process.env.COOLIFY_DEPLOY_TIMEOUT_MS ?? DEFAULT_DEPLOY_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
    throw new Error("COOLIFY_DEPLOY_TIMEOUT_MS must be an integer of at least 60000");
  }

  await Promise.all(
    deployments.map(async (deployment) => {
      const deploymentUuid = deployment.deployment_uuid;
      const resourceUuid = deployment.resource_uuid;
      if (typeof deploymentUuid !== "string" || typeof resourceUuid !== "string") {
        throw new Error("Coolify returned a deployment without string UUIDs");
      }
      console.log(`Queued ${resourceUuid}: ${deploymentUuid}`);
      await waitForDeployment({
        deploymentUuid,
        resourceUuid,
        timeoutMs,
        getDeployment: (uuid) =>
          coolifyJson(`${baseUrl}/api/v1/deployments/${encodeURIComponent(uuid)}`, token),
        onStatus: (status) => console.log(`${resourceUuid} (${deploymentUuid}): ${status}`),
      });
    }),
  );

  await verifyProduction();
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause instanceof Error) {
      console.error(`Caused by: ${error.cause.message}`);
    }
    process.exitCode = 1;
  });
}
