import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const script = new URL("./write-control-plane-discovery.mjs", import.meta.url);
const validEnvironment = {
  SOVEREIGN_RUNTIME_VERSION: "0.0.32+sovereign.gabcdef012345",
  T3CODE_OAUTH_ISSUER: "https://auth.example.test/api/auth",
  T3CODE_OAUTH_CLIENT_ID: "t3-code",
  T3CODE_OAUTH_RESOURCE: "https://relay.example.test",
  T3CODE_RELAY_URL: "https://relay.example.test",
  VITE_HOSTED_APP_URL: "https://code.example.test",
};

NodeTest.test("writes a complete public sovereign discovery document", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-discovery-"));
  try {
    const output = NodePath.join(directory, "t3-sovereign.json");
    const result = NodeChildProcess.spawnSync(process.execPath, [script.pathname, output], {
      encoding: "utf8",
      env: { ...process.env, ...validEnvironment },
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(output, "utf8")), {
      schemaVersion: 1,
      runtimeVersion: "0.0.32+sovereign.gabcdef012345",
      origin: "https://code.example.test",
      hostedAppUrl: "https://code.example.test",
      oauthIssuer: "https://auth.example.test/api/auth",
      oauthClientId: "t3-code",
      oauthResource: "https://relay.example.test",
      relayUrl: "https://relay.example.test",
    });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

NodeTest.test("rejects non-HTTPS and credential-bearing discovery endpoints", () => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [script.pathname, "/tmp/unused.json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...validEnvironment,
        T3CODE_RELAY_URL: "https://token@relay.example.test",
      },
    },
  );
  NodeAssert.notEqual(result.status, 0);
  NodeAssert.match(result.stderr, /credential-free HTTPS origin/u);
});
