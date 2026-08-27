import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  deriveServerRuntimeId,
  isServerRuntimeSourcePath,
  SERVER_RUNTIME_SOURCE_PATHS,
} from "./derive-server-runtime-id.mjs";

const serverEntries = [
  { path: "apps/server/src/server.ts", contentHash: "a".repeat(64) },
  { path: "packages/contracts/src/environment.ts", contentHash: "b".repeat(64) },
];

NodeTest.test("derives a deterministic identity from the server source closure", () => {
  const first = deriveServerRuntimeId(serverEntries);
  const reordered = deriveServerRuntimeId(serverEntries.toReversed());

  NodeAssert.match(first, /^sha256:[a-f0-9]{64}$/u);
  NodeAssert.equal(reordered, first);
});

NodeTest.test("changes identity when server closure content changes", () => {
  const changed = serverEntries.map((entry, index) =>
    index === 0 ? { ...entry, contentHash: "c".repeat(64) } : entry,
  );

  NodeAssert.notEqual(deriveServerRuntimeId(changed), deriveServerRuntimeId(serverEntries));
});

NodeTest.test("client-only entries do not participate in the server identity", () => {
  NodeAssert.equal(
    SERVER_RUNTIME_SOURCE_PATHS.some(
      (path) => path.startsWith("apps/desktop/") || path.startsWith("apps/web/"),
    ),
    false,
  );
});

NodeTest.test("test-only server files do not participate in the runtime identity", () => {
  NodeAssert.equal(isServerRuntimeSourcePath("apps/server/src/server.ts"), true);
  NodeAssert.equal(isServerRuntimeSourcePath("apps/server/src/server.test.ts"), false);
  NodeAssert.equal(
    isServerRuntimeSourcePath("apps/server/integration/providerService.integration.test.ts"),
    false,
  );
  NodeAssert.equal(
    isServerRuntimeSourcePath("apps/server/src/provider/testFixtures/session.json"),
    false,
  );
});
