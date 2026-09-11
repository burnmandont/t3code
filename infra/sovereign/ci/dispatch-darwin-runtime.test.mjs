import assert from "node:assert/strict";
import test from "node:test";

import { createDarwinRuntimeDispatch } from "./dispatch-darwin-runtime.mjs";

test("dispatches an exact Darwin runtime build", () => {
  assert.deepEqual(
    createDarwinRuntimeDispatch({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      runtimeVersion: "0.0.38+sovereign.g0123456789ab",
    }),
    {
      event_type: "sovereign_darwin_runtime",
      client_payload: {
        commit_sha: "0123456789abcdef0123456789abcdef01234567",
        runtime_version: "0.0.38+sovereign.g0123456789ab",
      },
    },
  );
});

test("rejects a runtime version from another commit", () => {
  assert.throws(
    () =>
      createDarwinRuntimeDispatch({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        runtimeVersion: "0.0.38+sovereign.gaaaaaaaaaaaa",
      }),
    /does not match/u,
  );
});
