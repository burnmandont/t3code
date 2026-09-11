import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { resolveRuntimePlatform, runtimeArtifactNames } from "./runtime-platform.mjs";

NodeTest.test("defines immutable Darwin arm64 runtime asset names", () => {
  const target = resolveRuntimePlatform("darwin", "arm64");
  NodeAssert.deepEqual(runtimeArtifactNames(target), {
    artifactFileName: "t3-sovereign-runtime-darwin-arm64.tar.gz",
    manifestFileName: "darwin-arm64.manifest.json",
  });
  NodeAssert.equal(target.frpcArchiveDirectory, "frp_0.70.1_darwin_arm64");
});

NodeTest.test("rejects runtime targets we do not publish", () => {
  NodeAssert.throws(() => resolveRuntimePlatform("darwin", "x64"), /not available/u);
});
