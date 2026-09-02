import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

import {
  classifyDeploymentStatus,
  CoolifyDeploymentTerminalError,
  deployResourcesWithRetry,
  expectedWebSocketAccept,
  pinCoolifyApplicationSources,
  unexpectedHostRequestOptions,
  validateEdgeSecurityHeaders,
  validateWebContentSecurityPolicy,
  waitForDeployment,
} from "./deploy-and-verify.mjs";

const assert = NodeAssert;
const readFileSync = NodeFS.readFileSync;
const test = NodeTest.test;

const readSovereignFile = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("classifies every Coolify deployment status", () => {
  assert.equal(classifyDeploymentStatus("queued"), "pending");
  assert.equal(classifyDeploymentStatus("in_progress"), "pending");
  assert.equal(classifyDeploymentStatus("finished"), "success");
  assert.equal(classifyDeploymentStatus("failed"), "failure");
  assert.equal(classifyDeploymentStatus("cancelled-by-user"), "failure");
  assert.throws(() => classifyDeploymentStatus("mystery"), /unknown deployment status/u);
});

test("waits through pending states and returns only after success", async () => {
  const statuses = ["queued", "in_progress", "finished"];
  const observed = [];
  const result = await waitForDeployment({
    deploymentUuid: "deployment-1",
    resourceUuid: "resource-1",
    getDeployment: async () => ({ status: statuses.shift() }),
    timeoutMs: 60_000,
    pollIntervalMs: 0,
    sleepFn: async () => {},
    onStatus: (status) => observed.push(status),
  });
  assert.equal(result.status, "finished");
  assert.deepEqual(observed, ["queued", "in_progress", "finished"]);
});

test("fails a completed unsuccessful deployment", async () => {
  await assert.rejects(
    waitForDeployment({
      deploymentUuid: "deployment-2",
      resourceUuid: "resource-2",
      getDeployment: async () => ({ status: "failed" }),
      timeoutMs: 60_000,
      pollIntervalMs: 0,
      sleepFn: async () => {},
    }),
    (error) =>
      error instanceof CoolifyDeploymentTerminalError &&
      error.status === "failed" &&
      error.resourceUuid === "resource-2",
  );
});

test("retries only failed Coolify resources once", async () => {
  const queued = [];
  const waited = [];
  const retries = [];
  await deployResourcesWithRetry({
    resourceUuids: ["control", "web"],
    maxAttempts: 2,
    retryDelayMs: 0,
    sleepFn: async () => {},
    queueDeployments: async (resourceUuids) => {
      queued.push(resourceUuids);
      return resourceUuids.map((resourceUuid, index) => ({
        resource_uuid: resourceUuid,
        deployment_uuid: `${resourceUuid}-${queued.length}-${index}`,
      }));
    },
    waitForQueuedDeployment: async (deployment, attempt) => {
      waited.push({ resourceUuid: deployment.resource_uuid, attempt });
      if (deployment.resource_uuid === "web" && attempt === 1) {
        throw new CoolifyDeploymentTerminalError({
          deploymentUuid: deployment.deployment_uuid,
          resourceUuid: deployment.resource_uuid,
          status: "failed",
        });
      }
    },
    onRetry: (retry) => retries.push(retry),
  });

  assert.deepEqual(queued, [["control", "web"], ["web"]]);
  assert.deepEqual(waited, [
    { resourceUuid: "control", attempt: 1 },
    { resourceUuid: "web", attempt: 1 },
    { resourceUuid: "web", attempt: 2 },
  ]);
  assert.deepEqual(retries, [{ attempt: 2, maxAttempts: 2, resourceUuids: ["web"] }]);
});

test("does not retry a deployment cancelled by the operator", async () => {
  let queueCount = 0;
  await assert.rejects(
    deployResourcesWithRetry({
      resourceUuids: ["web"],
      maxAttempts: 2,
      retryDelayMs: 0,
      sleepFn: async () => {},
      queueDeployments: async () => {
        queueCount += 1;
        return [{ resource_uuid: "web", deployment_uuid: "web-1" }];
      },
      waitForQueuedDeployment: async (deployment) => {
        throw new CoolifyDeploymentTerminalError({
          deploymentUuid: deployment.deployment_uuid,
          resourceUuid: deployment.resource_uuid,
          status: "cancelled-by-user",
        });
      },
    }),
    /cancelled-by-user/u,
  );
  assert.equal(queueCount, 1);
});

test("rejects incomplete or unexpected Coolify queue responses", async () => {
  await assert.rejects(
    deployResourcesWithRetry({
      resourceUuids: ["control", "web"],
      queueDeployments: async () => [{ resource_uuid: "control", deployment_uuid: "control-1" }],
      waitForQueuedDeployment: async () => {},
    }),
    /did not accept every resource: web/u,
  );
  await assert.rejects(
    deployResourcesWithRetry({
      resourceUuids: ["web"],
      queueDeployments: async () => [
        { resource_uuid: "attacker", deployment_uuid: "unexpected-1" },
      ],
      waitForQueuedDeployment: async () => {},
    }),
    /unexpected resource/u,
  );
});

test("pins every Coolify resource to the exact production branch commit", async () => {
  const updates = [];
  await pinCoolifyApplicationSources({
    resourceUuids: ["observability", "control", "web"],
    branch: "sovereign/main",
    commitSha: "a".repeat(40),
    updateApplication: async (resourceUuid, source) => updates.push({ resourceUuid, source }),
  });
  assert.deepEqual(updates, [
    {
      resourceUuid: "observability",
      source: { git_branch: "sovereign/main", git_commit_sha: "a".repeat(40) },
    },
    {
      resourceUuid: "control",
      source: { git_branch: "sovereign/main", git_commit_sha: "a".repeat(40) },
    },
    {
      resourceUuid: "web",
      source: { git_branch: "sovereign/main", git_commit_sha: "a".repeat(40) },
    },
  ]);
  await assert.rejects(
    pinCoolifyApplicationSources({
      resourceUuids: ["web"],
      branch: "sovereign/main",
      commitSha: "HEAD",
      updateApplication: async () => {},
    }),
    /exact 40-character lowercase commit SHA/u,
  );
});

test("requires all edge security headers", () => {
  const headers = new Headers({
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff, nosniff",
    "x-frame-options": "DENY, DENY",
    "referrer-policy": "no-referrer, no-referrer",
  });
  assert.doesNotThrow(() => validateEdgeSecurityHeaders(headers, "test"));
  headers.set("x-frame-options", "DENY, SAMEORIGIN");
  assert.throws(() => validateEdgeSecurityHeaders(headers, "test"), /x-frame-options/u);
});

test("computes the RFC 6455 WebSocket accept value", () => {
  assert.equal(expectedWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("requires the hosted web content security policy", () => {
  const headers = new Headers({
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src-attr 'none'; connect-src 'self' https: wss:",
  });
  assert.doesNotThrow(() => validateWebContentSecurityPolicy(headers));
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  );
  assert.throws(() => validateWebContentSecurityPolicy(headers), /script-src-attr/u);
});

test("keeps the FRPS control listener behind the exact WebSocket route", () => {
  const edge = readSovereignFile("../proxy/edge.nginx.conf");
  const second = readSovereignFile("../proxy/second.nginx.conf");
  const edgeApex = edge.slice(
    edge.indexOf("# Public Sovereign Relay FRPC control channel"),
    edge.indexOf("# Public HTTP/WebSocket traffic for linked environments"),
  );
  const secondApex = second.slice(
    second.indexOf("server {\n    server_name connect.moondiner.com;"),
    second.indexOf("server {\n    server_name *.connect.moondiner.com;"),
  );

  for (const config of [edgeApex, secondApex]) {
    assert.match(config, /location = \/~!frp/u);
    assert.match(config, /return 426;/u);
    assert.match(config, /frp_origin_allowed = 0\) \{ return 403;/u);
    assert.match(config, /location \/ \{\s*return 404;/u);
    assert.match(config, /client_max_body_size 64k;/u);
  }
  for (const config of [edge, second]) {
    assert.match(config, /"http:\/\/connect[.]moondiner[.]com"\s+1;/u);
    assert.match(config, /"https:\/\/connect[.]moondiner[.]com"\s+1;/u);
    assert.match(config, /api\/auth\/\(\?:browser-session\|pairing-token\|websocket-ticket\)/u);
  }
  assert.match(edge, /zone=t3_connect_handshake_rate:10m rate=5r\/s/u);
});

test("keeps FRPS durable across every split control deployment", () => {
  const controlCompose = readSovereignFile("../compose.control.yaml");
  const frpsService = controlCompose.slice(controlCompose.indexOf("  frps:"));

  assert.match(frpsService, /^  frps:\n/mu);
  assert.doesNotMatch(frpsService, /^    profiles:/mu);
  assert.match(frpsService, /restart: unless-stopped/u);
  assert.match(frpsService, /nc -z -w 2 127[.]0[.]0[.]1 7000/u);
  assert.match(frpsService, /nc -z -w 2 127[.]0[.]0[.]1 8080/u);
});

test("runs a private self-hosted monitor with the split control plane", () => {
  const controlCompose = readSovereignFile("../compose.control.yaml");
  const monitorService = controlCompose.slice(controlCompose.indexOf("  monitor:"));

  assert.match(monitorService, /^  monitor:\n/mu);
  assert.doesNotMatch(monitorService, /^    profiles:/mu);
  assert.match(monitorService, /T3_MONITOR_ALERT_WEBHOOK_URL/u);
  assert.match(monitorService, /condition: service_healthy/u);
  assert.doesNotMatch(monitorService, /^    ports:/mu);
  assert.match(monitorService, /^    expose:\n      - "4300"/mu);
});

test("keeps the observability stack authenticated, private, and persistent", () => {
  const compose = readSovereignFile("../compose.observability.yaml");
  const gateway = readSovereignFile("../observability/Caddyfile");
  const controlCompose = readSovereignFile("../compose.control.yaml");

  assert.doesNotMatch(compose, /^    ports:/mu);
  assert.match(compose, /T3_OTLP_INGEST_TOKEN: \$\{T3_OTLP_INGEST_TOKEN:\?required\}/u);
  assert.match(compose, /T3_LOKI_INGEST_TOKEN: \$\{T3_LOKI_INGEST_TOKEN:\?required\}/u);
  assert.match(compose, /T3_LOKI_INGEST_BASIC_AUTH: \$\{T3_LOKI_INGEST_BASIC_AUTH:\?required\}/u);
  assert.match(compose, /gateway:\n[\s\S]*?cap_add:\n      - NET_BIND_SERVICE/u);
  assert.match(
    compose,
    /traefik[.]http[.]routers[.]t3-sovereign-observability[.]rule: Host\(`observe[.]moondiner[.]com`\) && PathPrefix\(`\/`\)/u,
  );
  assert.match(
    compose,
    /traefik[.]http[.]services[.]t3-sovereign-observability[.]loadbalancer[.]server[.]port: "8080"/u,
  );
  assert.doesNotMatch(compose, /t3-sovereign-observability[.]tls[.]certresolver/u);
  assert.match(compose, /telemetry-storage-init:\n[\s\S]*?exclude_from_hc: true/u);
  assert.match(
    compose,
    /telemetry-storage-init:\n[\s\S]*?cap_add:\n      - CHOWN\n      - DAC_OVERRIDE/u,
  );
  assert.match(
    compose,
    /command: \["chown", "-R", "10001:10001", "\/var\/loki", "\/var\/tempo"\]/u,
  );
  assert.match(compose, /loki:\n[\s\S]*?condition: service_completed_successfully/u);
  assert.match(compose, /tempo:\n[\s\S]*?condition: service_completed_successfully/u);
  assert.match(compose, /cadvisor:\n[\s\S]*?--docker_only=true/u);
  assert.match(compose, /cadvisor:\n[\s\S]*?--housekeeping_interval=30s/u);
  assert.match(
    compose,
    /cadvisor:\n[\s\S]*?--disable_metrics=disk,diskIO,percpu,perf_event,pressure/u,
  );
  for (const volume of [
    "prometheus-data",
    "alertmanager-data",
    "loki-data",
    "tempo-data",
    "grafana-data",
  ]) {
    assert.match(compose, new RegExp(`^  ${volume}:$`, "mu"));
  }
  assert.match(gateway, /not header Authorization "Bearer \{\$T3_OTLP_INGEST_TOKEN\}"/u);
  assert.match(
    gateway,
    /not header_regexp Authorization "\^\(Bearer \{\$T3_LOKI_INGEST_TOKEN\}\|\{\$T3_LOKI_INGEST_BASIC_AUTH\}\)\$"/u,
  );
  assert.match(gateway, /handle \/health \{\n    respond 200\n  \}/u);
  assert.match(controlCompose, /^  telemetry-agent:/mu);
  assert.match(
    controlCompose,
    /T3_OBSERVABILITY_INGEST_TOKEN: \$\{T3_OTLP_INGEST_TOKEN:\?required\}/u,
  );
  assert.match(controlCompose, /T3_OTLP_METRICS_URL: http:\/\/telemetry-agent:4318\/v1\/metrics/u);
});

test("redacts request headers before traces leave the collector", () => {
  const collector = readSovereignFile("../observability/collector.yaml");

  assert.match(collector, /^  transform\/redact_request_headers:/mu);
  assert.match(
    collector,
    /delete_matching_keys\(resource\.attributes, "\^http\\\\\.request\\\\\.header\\\\\.\.\+\$"\)/u,
  );
  assert.match(
    collector,
    /delete_matching_keys\(span\.attributes, "\^http\\\\\.request\\\\\.header\\\\\.\.\+\$"\)/u,
  );
  assert.match(
    collector,
    /delete_matching_keys\(spanevent\.attributes, "\^http\\\\\.request\\\\\.header\\\\\.\.\+\$"\)/u,
  );
  assert.match(
    collector,
    /processors: \[memory_limiter, transform\/redact_request_headers, batch\]/u,
  );
});

test("allows the slower container metrics scrape to complete", () => {
  const prometheus = readSovereignFile("../observability/prometheus.yaml");

  assert.match(
    prometheus,
    /- job_name: containers\n    scrape_interval: 45s\n    scrape_timeout: 30s\n    static_configs:/u,
  );
});

test("keeps sovereign APNs opt-in and replaces the hosted queue with PostgreSQL", () => {
  const controlCompose = readSovereignFile("../compose.control.yaml");
  const queue = readSovereignFile("../../relay/src/agentActivity/SovereignApnsQueue.ts");
  const transport = readSovereignFile("../../relay/src/agentActivity/SovereignApnsClient.ts");
  const migration = readSovereignFile(
    "../../relay/drizzle/20260808174028_remarkable_hammerhead/migration.sql",
  );

  assert.match(controlCompose, /T3_APNS_ENABLED: "\$\{T3_APNS_ENABLED:-false\}"/u);
  assert.match(queue, /FOR UPDATE SKIP LOCKED/u);
  assert.match(queue, /state: deadLetter \? "dead_letter" : "pending"/u);
  assert.match(transport, /from "node:http2"/u);
  assert.match(migration, /CREATE TABLE "relay_apns_delivery_jobs"/u);
  assert.doesNotMatch(controlCompose, /^  apns:/mu);
});

test("validates logical backups through isolated restores", () => {
  const restoreValidator = readSovereignFile("../postgres/validate-logical-restore.sh");
  const fullRestoreValidator = readSovereignFile("../postgres/validate-full-restore.sh");
  const remoteHomeValidator = readSovereignFile("../runtime/validate-remote-home-restore.sh");

  assert.match(restoreValidator, /label=coolify[.]resourceName=t3-postgres/u);
  assert.match(restoreValidator, /pg_dump/u);
  assert.match(restoreValidator, /pg_restore --exit-on-error/u);
  assert.match(restoreValidator, /trap cleanup EXIT/u);
  assert.match(restoreValidator, /diff -u/u);
  assert.doesNotMatch(restoreValidator, /docker (?:rm|volume rm)/u);

  assert.match(fullRestoreValidator, /docker network create --internal/u);
  assert.match(fullRestoreValidator, /[.]Internal/u);
  assert.match(fullRestoreValidator, /--tmpfs \/var\/lib\/postgresql\/data/u);
  assert.match(fullRestoreValidator, /pg_restore --exit-on-error/u);
  assert.match(fullRestoreValidator, /node \/app\/account-migrate[.]mjs/u);
  assert.match(fullRestoreValidator, /node \/app\/relay-migrate[.]mjs/u);
  assert.match(fullRestoreValidator, /node \/app\/account-server[.]mjs/u);
  assert.match(fullRestoreValidator, /\/app\/start-relay[.]sh/u);
  assert.match(fullRestoreValidator, /T3_APNS_ENABLED=false/u);
  assert.match(fullRestoreValidator, /--cap-drop ALL/u);
  assert.match(fullRestoreValidator, /HostConfig[.]PortBindings/u);
  assert.match(fullRestoreValidator, /tableowner/u);
  assert.match(fullRestoreValidator, /--format '\{\{[.]Image\}\}'/u);
  assert.match(fullRestoreValidator, /trap cleanup EXIT/u);
  assert.doesNotMatch(fullRestoreValidator, /docker volume/u);

  assert.match(remoteHomeValidator, /[.]backup/u);
  assert.match(remoteHomeValidator, /PRAGMA integrity_check/u);
  assert.match(remoteHomeValidator, /projection_threads/u);
  assert.match(remoteHomeValidator, /orchestration_events/u);
  assert.match(remoteHomeValidator, /environment-id/u);
  assert.match(remoteHomeValidator, /secret_manifest/u);
  assert.match(remoteHomeValidator, /tar --extract/u);
  assert.match(remoteHomeValidator, /trap cleanup EXIT/u);
  assert.doesNotMatch(remoteHomeValidator, /systemctl --user (?:stop|restart)/u);
  assert.doesNotMatch(remoteHomeValidator, /runtime\/versions/u);
  assert.doesNotMatch(remoteHomeValidator, /userdata\/logs/u);
});

test("keeps sovereign browser requests local unless the user opens a URL", () => {
  const dockerfile = readSovereignFile("../Dockerfile.web");
  const controlDockerfile = readSovereignFile("../Dockerfile.control-plane");
  const webNginx = readSovereignFile("../nginx.conf");

  assert.match(dockerfile, /^ENV VITE_REMOTE_FAVICONS=0$/mu);
  assert.match(dockerfile, /--filter @t3tools\/scripts[.][.][.]/u);
  assert.match(controlDockerfile, /infra\/account\/src\/accountClient[.]ts/u);
  assert.match(controlDockerfile, /--outfile=\/out\/account-client[.]js/u);
  assert.match(
    controlDockerfile,
    /^ENV T3_ACCOUNT_CLIENT_SCRIPT_PATH=\/app\/account-client[.]js$/mu,
  );
  assert.match(webNginx, /Content-Security-Policy/u);
  assert.match(webNginx, /script-src-attr 'none'/u);
});

test("binds the hosted client build to Coolify's exact source commit", () => {
  const dockerfile = readSovereignFile("../Dockerfile.web");
  const webCompose = readSovereignFile("../compose.web.yaml");
  const bootstrapCompose = readSovereignFile("../compose.yaml");

  assert.match(dockerfile, /^ARG SOURCE_COMMIT$/mu);
  assert.match(dockerfile, /set-runtime-version[.]mjs --print-only/u);
  assert.match(dockerfile, /derive-server-runtime-id[.]mjs/u);
  assert.match(dockerfile, /SOVEREIGN_RUNTIME_VERSION="\$runtime_version"/u);
  assert.match(
    dockerfile,
    /APP_VERSION="\$runtime_version" T3CODE_TARGET_SERVER_RUNTIME_ID="\$server_runtime_id" pnpm --filter @t3tools\/web build/u,
  );
  for (const compose of [webCompose, bootstrapCompose]) {
    assert.match(compose, /SOURCE_COMMIT: \$\{SOURCE_COMMIT:\?Coolify must include/u);
  }
});

test("installs dependencies for source trees included by the desktop typecheck", () => {
  const workflow = readSovereignFile("../../../.gitea/workflows/sovereign-ci-deploy.yml");
  const runtimeBuilder = readSovereignFile("../runtime/build-runtime-artifact.mjs");
  const serverPackage = JSON.parse(readSovereignFile("../../../apps/server/package.json"));

  assert.match(workflow, /--filter @t3tools\/desktop[.][.][.]/u);
  assert.match(workflow, /--filter @t3tools\/mobile[.][.][.]/u);
  assert.match(workflow, /--filter @t3tools\/scripts[.][.][.]/u);
  assert.match(workflow, /pnpm rebuild esbuild/u);
  assert.doesNotMatch(workflow, /pnpm rebuild esbuild node-pty/u);
  assert.equal(serverPackage.devDependencies["node-gyp"], "12.3.0");
  assert.match(runtimeBuilder, /apps\/server\/node_modules\/[.]bin\/node-gyp/u);
  assert.match(runtimeBuilder, /NodeChildProcess[.]execFileSync\(nodeGyp, \["rebuild"\]/u);
  assert.match(runtimeBuilder, /"--ignore-scripts"/u);
  assert.match(runtimeBuilder, /sovereign-runtime-pty-ok/u);
  assert.match(runtimeBuilder, /require\("msgpackr-extract"\)/u);
  assert.match(workflow, /node apps\/desktop\/node_modules\/electron\/install[.]js/u);
  assert.equal(
    [
      ...workflow.matchAll(
        /for attempt in 1 2 3; do\s+if node apps\/desktop\/node_modules\/electron\/install[.]js;/gu,
      ),
    ].length,
    1,
  );
  assert.match(workflow, /Electron executable missing/u);
});

test("validates pull requests without production authority", () => {
  const workflow = readSovereignFile("../../../.gitea/workflows/sovereign-pr.yml");

  assert.match(workflow, /pull_request:\s+branches:\s+- sovereign\/main/su);
  assert.match(workflow, /group: sovereign-pr-/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /permissions:\s+contents: read/su);
  assert.match(workflow, /pnpm --filter @t3tools\/contracts typecheck/u);
  assert.match(workflow, /pnpm --filter @t3tools\/client-runtime test/u);
  assert.match(workflow, /pnpm --filter t3code-account test/u);
  assert.match(workflow, /pnpm --filter t3code-relay test/u);
  assert.match(workflow, /node --test infra\/sovereign\/ci\/deploy-and-verify[.]test[.]mjs/u);
  assert.match(workflow, /pnpm exec vp run build:desktop/u);
  assert.match(workflow, /T3CODE_BUILD_NEUTRAL_PUBLIC_RUNTIME: "1"/u);
  assert.match(
    workflow,
    /test ! -e apps\/server\/dist\/client\/[.]well-known\/t3-sovereign[.]json/u,
  );

  assert.doesNotMatch(workflow, /\$\{\{\s*secrets[.]/u);
  assert.doesNotMatch(workflow, /COOLIFY_/u);
  assert.doesNotMatch(workflow, /SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64/u);
  assert.doesNotMatch(workflow, /SOVEREIGN_PACKAGE_TOKEN/u);
  assert.doesNotMatch(workflow, /build-runtime-artifact[.]mjs/u);
  assert.doesNotMatch(workflow, /publish-runtime-artifact[.]mjs/u);
  assert.doesNotMatch(workflow, /publish-github-runtime[.]mjs/u);
  assert.doesNotMatch(workflow, /dispatch-apple-release[.]mjs/u);
  assert.doesNotMatch(workflow, /run: node infra\/sovereign\/ci\/deploy-and-verify[.]mjs/u);
});

test("publishes a signed complete remote runtime before production deployment", () => {
  const workflow = readSovereignFile("../../../.gitea/workflows/sovereign-ci-deploy.yml");
  const buildIndex = workflow.indexOf("Build signed complete sovereign runtime");
  const publishIndex = workflow.indexOf("Publish immutable sovereign runtime to Gitea");
  const deployIndex = workflow.indexOf("Deploy observability, t3-control, and t3-web");

  assert.match(workflow, /pnpm --filter t3 typecheck/u);
  assert.match(workflow, /pnpm --filter t3 test/u);
  assert.match(workflow, /SOVEREIGN_RUNTIME_SIGNING_PRIVATE_KEY_B64/u);
  assert.match(workflow, /SOVEREIGN_PACKAGE_TOKEN/u);
  assert.match(workflow, /SOVEREIGN_FRPC_ASSET_URL/u);
  assert.match(workflow, /T3CODE_HOSTED_APP_URL: https:\/\/code[.]moondiner[.]com/u);
  assert.match(
    workflow,
    /grep -Fq 'https:\/\/code[.]moondiner[.]com' apps\/server\/dist\/bin[.]mjs/u,
  );
  assert.ok(buildIndex > 0);
  assert.ok(publishIndex > buildIndex);
  assert.ok(deployIndex > publishIndex);
});

test("publishes the credentialless installer and runtime before production deployment", () => {
  const workflow = readSovereignFile("../../../.gitea/workflows/sovereign-ci-deploy.yml");
  const externalPublishIndex = workflow.indexOf(
    "Publish credentialless sovereign runtime to GitHub",
  );
  const deployIndex = workflow.indexOf("Deploy observability, t3-control, and t3-web");

  assert.ok(externalPublishIndex > 0);
  assert.ok(deployIndex > externalPublishIndex);
  assert.match(workflow, /SOVEREIGN_GITHUB_REPOSITORY/u);
  assert.match(workflow, /SOVEREIGN_GITHUB_PAGES_ORIGIN/u);
  assert.match(workflow, /SOVEREIGN_GITHUB_TOKEN/u);
  assert.match(workflow, /publish-github-runtime[.]mjs/u);
  assert.match(workflow, /T3CODE_SERVER_RUNTIME_ID/u);
  assert.match(workflow, /T3CODE_TARGET_SERVER_RUNTIME_ID/u);
});

test("dispatches desktop and iOS releases to a separately trusted GitHub builder", () => {
  const workflow = readSovereignFile("../../../.gitea/workflows/sovereign-ci-deploy.yml");
  const builder = readSovereignFile("../apple-builder/.github/workflows/release-apple.yml");

  assert.match(workflow, /Dispatch Apple release to ephemeral GitHub runners/u);
  assert.match(workflow, /github[.]ref == 'refs\/heads\/sovereign\/main'/u);
  assert.doesNotMatch(workflow, /SOVEREIGN_GITHUB_BUILDER_REPOSITORY/u);
  assert.match(workflow, /SOVEREIGN_GITHUB_REPOSITORY/u);
  assert.match(
    workflow,
    /SOVEREIGN_GITHUB_BUILDER_TOKEN: \$\{\{ secrets[.]SOVEREIGN_GITHUB_TOKEN \}\}/u,
  );
  assert.match(workflow, /dispatch-apple-release[.]mjs/u);
  assert.doesNotMatch(workflow, /runs-on: sovereign-macos-arm64/u);
  assert.match(builder, /repository_dispatch:/u);
  assert.match(builder, /ios_build_number:/u);
  assert.match(builder, /validate-config:/u);
  assert.match(builder, /Missing GitHub Actions configuration/u);
  assert.doesNotMatch(builder, /CLERK_PASSKEY_RP_DOMAINS/u);
  assert.doesNotMatch(builder, /MACOS_PROVISIONING_PROFILE/u);
  assert.match(builder, /APPLE_TEAM_ID/u);
  assert.match(builder, /IOS_BUNDLE_ID/u);
  assert.doesNotMatch(builder, /APPLE_DISTRIBUTION_P12/u);
  assert.doesNotMatch(builder, /security create-keychain/u);
  assert.match(builder, /GITEA_CLONE_USERNAME/u);
  assert.match(builder, /GITEA_CLONE_TOKEN/u);
  assert.match(builder, /Verify read-only Gitea source access/u);
  assert.match(builder, /GIT_ASKPASS/u);
  assert.match(builder, /GIT_TERMINAL_PROMPT=0/u);
  assert.match(builder, /https:\/\/source[.]moondiner[.]com\/t3_fork\/sovereign[.]git/u);
  assert.doesNotMatch(builder, /GITEA_DEPLOY_KEY/u);
  assert.doesNotMatch(builder, /ssh-ed25519/u);
  assert.doesNotMatch(builder, /IdentitiesOnly=yes/u);
  assert.match(builder, /needs: validate-config/u);
  assert.match(builder, /runs-on: macos-15/u);
  assert.doesNotMatch(builder, /runs-on: macos-15-intel/u);
  assert.match(builder, /timeout-minutes: 90/u);
  assert.match(builder, /timeout-minutes: 120/u);
  assert.match(builder, /artifact_run_id:/u);
  assert.match(builder, /run-id: \$\{\{ inputs[.]artifact_run_id \}\}/u);
  assert.match(builder, /actions: read/u);
  assert.match(builder, /git fetch --depth=1 origin "\$SOURCE_SHA"/u);
  assert.match(builder, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/u);
  assert.match(builder, /--arch "\$\{\{ matrix[.]arch \}\}"/u);
  assert.match(builder, /derive-server-runtime-id[.]mjs/u);
  assert.match(builder, /T3CODE_SERVER_RUNTIME_ID/u);
  assert.match(builder, /T3CODE_TARGET_SERVER_RUNTIME_ID/u);
  assert.match(builder, /hdiutil attach "\$dmg" -readonly -nobrowse -mountpoint/u);
  assert.match(builder, /codesign --verify --deep --strict/u);
  assert.match(builder, /xcrun stapler validate "\$app"/u);
  assert.match(builder, /spctl --assess --type execute --verbose "\$app"/u);
  assert.doesNotMatch(builder, /xcrun stapler validate "\$dmg"/u);
  assert.match(builder, /build-ios:/u);
  assert.match(builder, /DEVELOPER_DIR: \/Applications\/Xcode_26[.]3[.]app\/Contents\/Developer/u);
  assert.ok(builder.includes("swift --version | grep -Eq 'Swift version (6[.][2-9]|[7-9][.])'"));
  assert.match(
    builder,
    /T3CODE_IOS_BUILD_NUMBER: \$\{\{ github[.]event[.]client_payload[.]ios_build_number \|\| inputs[.]ios_build_number \}\}/u,
  );
  assert.match(builder, /T3CODE_EXPO_UPDATES_URL: ""/u);
  assert.match(builder, /expo prebuild --clean --platform ios/u);
  assert.match(builder, /workspaces=\(ios\/[*][.]xcworkspace\)/u);
  assert.match(builder, /Expected exactly one generated iOS workspace/u);
  assert.match(builder, /test "\$scheme" = "Sovereign"/u);
  assert.match(builder, /SOVEREIGN_IOS_WORKSPACE/u);
  assert.match(builder, /SOVEREIGN_IOS_SCHEME/u);
  assert.match(builder, /-workspace "\$SOVEREIGN_IOS_WORKSPACE"/u);
  assert.match(builder, /-scheme "\$SOVEREIGN_IOS_SCHEME"/u);
  assert.match(builder, /-destination 'generic\/platform=iOS'/u);
  assert.match(builder, /-allowProvisioningUpdates/u);
  assert.match(builder, /-authenticationKeyPath "\$APPLE_API_KEY"/u);
  assert.match(builder, /codesign --verify --deep --strict --verbose=2 "\$app"/u);
  assert.match(builder, /test "\$archive_bundle_id" = "\$T3CODE_IOS_BUNDLE_ID_PRODUCTION"/u);
  assert.match(builder, /test "\$archive_build_number" = "\$IOS_BUILD_NUMBER"/u);
  assert.match(builder, /-exportOptionsPlist infra\/sovereign\/ci\/ExportOptions[.]plist/u);
  assert.match(builder, /SOVEREIGN_GITHUB_TOKEN: \$\{\{ github[.]token \}\}/u);
  assert.match(builder, /publish-desktop-release[.]mjs/u);
});

test("rejects Clerk and cloudflared implementations in sovereign artifacts", () => {
  const workflow = readSovereignFile("../../../.gitea/workflows/sovereign-ci-deploy.yml");
  const serverBuild = readSovereignFile("../../../apps/server/vite.config.ts");

  assert.match(workflow, /-e '@clerk\/electron'/u);
  assert.match(workflow, /-e '@clerk\/react'/u);
  assert.match(workflow, /-e 'cloudflared\/releases\/download'/u);
  assert.match(workflow, /inactive external provider implementation/u);
  assert.match(serverBuild, /SovereignConnectorLayer[.]ts/u);
  assert.match(serverBuild, /CloudflareConnectorLayer[.]ts/u);
});

test("allows only hosted and exact current or migration desktop origins to call the relay", () => {
  for (const path of ["../compose.yaml", "../compose.control.yaml"]) {
    const compose = readSovereignFile(path);
    assert.match(
      compose,
      /T3_RELAY_ALLOWED_ORIGINS: \$\{T3_CODE_URL:-https:\/\/code[.]moondiner[.]com\},t3code:\/\/app,t3code-dev:\/\/app,sovereign:\/\/app,sovereign-dev:\/\/app/u,
    );
    assert.doesNotMatch(compose, /T3_RELAY_ALLOWED_ORIGINS: ["']?\*["']?/u);
  }
});

test("allows the signup allowlist to be cleared for passkey-only operation", () => {
  for (const path of ["../compose.yaml", "../compose.control.yaml"]) {
    const compose = readSovereignFile(path);
    assert.match(compose, /T3_ACCOUNT_ALLOWED_EMAILS: "\$\{T3_ACCOUNT_ALLOWED_EMAILS:-\}"/u);
    assert.doesNotMatch(
      compose,
      /T3_ACCOUNT_ALLOWED_EMAILS: \$\{T3_ACCOUNT_ALLOWED_EMAILS:\?required\}/u,
    );
  }
});

test("preserves the sole passkey and records the operator recovery root", () => {
  const accountClient = readSovereignFile("../../account/src/accountClient.ts");
  const accountReadme = readSovereignFile("../../account/README.md");
  const securityReview = readSovereignFile("../SECURITY.md");

  assert.match(accountClient, /passkeys[.]length <= 1/u);
  assert.match(accountReadme, /Never expose a temporarily re-enabled password endpoint/u);
  assert.match(securityReview, /one platform passkey/u);
});

test("keeps every email/password route behind the operator source boundary", () => {
  const passwordRoutes = [
    "sign-in/email",
    "sign-up/email",
    "change-password",
    "set-password",
    "verify-password",
    "request-password-reset",
    "reset-password",
  ];

  for (const path of ["../proxy/edge.nginx.conf", "../proxy/second.nginx.conf"]) {
    const config = readSovereignFile(path);
    const routeMap = config.slice(
      config.indexOf('map "$host:$uri" $t3_operator_auth_route'),
      config.indexOf("geo $t3_operator_source"),
    );
    const sourceBoundary = config.slice(
      config.indexOf("geo $t3_operator_source"),
      config.indexOf("# Do not persist OAuth authorization codes"),
    );

    assert.ok(routeMap.includes("auth[.]moondiner[.]com"));
    for (const route of passwordRoutes) {
      assert.match(routeMap, new RegExp(route.replace("/", "\\/"), "u"));
    }
    for (const publicRoute of ["passkey", "oauth2", "get-session", "jwks"]) {
      assert.doesNotMatch(routeMap, new RegExp(publicRoute, "u"));
    }
    assert.match(routeMap, /\/\?\$/u);

    assert.match(sourceBoundary, /73[.]128[.]177[.]70\/32\s+1;/u);
    assert.match(sourceBoundary, /84[.]20[.]25[.]87\/32\s+1;/u);
    assert.match(sourceBoundary, /"1:0"\s+1;/u);
    assert.match(config, /if \(\$t3_reject_operator_auth_route = 1\) \{ return 403; \}/u);
  }
});

test("keeps public control routes behind the trusted second-proxy edge peer", () => {
  const edge = readSovereignFile("../proxy/edge.nginx.conf");
  const second = readSovereignFile("../proxy/second.nginx.conf");
  const codeServer = second.slice(
    second.indexOf("server {\n    server_name code.moondiner.com;"),
    second.indexOf("server {\n    server_name auth.moondiner.com;"),
  );
  const accountServer = second.slice(
    second.indexOf("server {\n    server_name auth.moondiner.com;"),
    second.indexOf("server {\n    server_name relay.moondiner.com;"),
  );
  const relayServer = second.slice(
    second.indexOf("server {\n    server_name relay.moondiner.com;"),
    second.indexOf("server {\n    server_name connect.moondiner.com;"),
  );

  assert.doesNotMatch(edge, /t3_reject_restricted_control_host/u);

  assert.match(second, /map \$realip_remote_addr \$t3_trusted_edge_peer/u);
  for (const edgeAddress of ["66.228.57.125", "170.187.154.70", "45.79.202.71"]) {
    assert.match(second, new RegExp(edgeAddress.replaceAll(".", "\\."), "u"));
  }
  for (const publicServer of [codeServer, accountServer, relayServer]) {
    assert.match(publicServer, /if \(\$t3_trusted_edge_peer = 0\) \{ return 403; \}/u);
    assert.doesNotMatch(publicServer, /allow 73[.]128[.]177[.]70;/u);
    assert.doesNotMatch(publicServer, /allow 84[.]20[.]25[.]87;/u);
    assert.doesNotMatch(publicServer, /deny all;/u);
  }
});

test("caps unauthenticated environment control bodies without blocking turn attachments", () => {
  for (const path of ["../proxy/edge.nginx.conf", "../proxy/second.nginx.conf"]) {
    const config = readSovereignFile(path);
    const wildcardServer = config.slice(config.indexOf("server_name *.connect.moondiner.com;"));
    const smallControlLocation = wildcardServer.slice(
      wildcardServer.indexOf("location ~ ^/(?:api/auth/(?:browser-session"),
      wildcardServer.indexOf("location / {"),
    );

    for (const route of [
      "api/auth/(?:browser-session|pairing-token|websocket-ticket)",
      "oauth/token",
      "api/connect/mint-credential",
      "api/t3-connect/(?:health|mint-credential)",
    ]) {
      assert.ok(smallControlLocation.includes(route));
    }
    assert.match(smallControlLocation, /client_max_body_size 64k;/u);
    assert.match(wildcardServer, /proxy_cookie_flags ~ secure;/u);
  }

  const edge = readSovereignFile("../proxy/edge.nginx.conf");
  const edgeWildcard = edge.slice(edge.indexOf("server_name *.connect.moondiner.com;"));
  assert.match(edgeWildcard, /client_max_body_size 100m;/u);
});

test("does not write URL queries or request headers to sovereign access logs", () => {
  for (const path of ["../proxy/edge.nginx.conf", "../proxy/second.nginx.conf", "../nginx.conf"]) {
    const config = readSovereignFile(path);
    const logFormat = config.slice(
      config.indexOf("log_format t3_sanitized"),
      config.indexOf("';", config.indexOf("log_format t3_sanitized")) + 2,
    );
    assert.match(logFormat, /\$uri/u);
    assert.doesNotMatch(logFormat, /\$request(?:_uri)?\b/u);
    assert.doesNotMatch(logFormat, /\$http_/u);
    assert.match(config, /access_log [^;]+ t3_sanitized;/u);
  }
});

test("rejects unknown edge hosts before an unrelated virtual host can proxy them", () => {
  const edge = readSovereignFile("../proxy/edge.nginx.conf");

  assert.match(edge, /listen 80 default_server;/u);
  assert.match(edge, /listen 443 ssl default_server;/u);
  assert.match(edge, /server_name _;/u);
  assert.match(edge, /t3-sovereign-rejected-hosts[.]log t3_sanitized/u);
  assert.match(edge, /return 421;/u);

  const requestOptions = unexpectedHostRequestOptions();
  assert.equal(requestOptions.hostname, "code.moondiner.com");
  assert.equal(requestOptions.servername, "code.moondiner.com");
  assert.equal(requestOptions.headers.Host, "attacker.invalid");
});
