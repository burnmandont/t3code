import assert from "node:assert/strict";
import test from "node:test";

import { deriveClientRelease } from "./derive-client-release.mjs";

test("derives monotonic desktop and iOS versions from the CI run", () => {
  assert.deepEqual(deriveClientRelease({ baseVersion: "0.0.33", runNumber: 42 }), {
    desktopVersion: "0.0.3300042",
    iosBuildNumber: "100042",
  });
  assert.deepEqual(deriveClientRelease({ baseVersion: "0.1.0", runNumber: 43 }), {
    desktopVersion: "0.1.43",
    iosBuildNumber: "100043",
  });
});

test("rejects invalid or non-monotonic inputs", () => {
  assert.throws(() => deriveClientRelease({ baseVersion: "0.0.33-dev", runNumber: 1 }));
  assert.throws(() => deriveClientRelease({ baseVersion: "0.0.33", runNumber: 0 }));
  assert.throws(() => deriveClientRelease({ baseVersion: "0.0.33", runNumber: 100_000 }));
});
