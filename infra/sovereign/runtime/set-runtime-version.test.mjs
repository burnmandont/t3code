import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  deriveSovereignPackageVersion,
  setSovereignPackageVersions,
} from "./set-runtime-version.mjs";

NodeTest.test("gives the server and client one exact commit-addressed version", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-version-"));
  const serverPath = NodePath.join(directory, "server.json");
  const webPath = NodePath.join(directory, "web.json");
  try {
    await NodeFSP.writeFile(serverPath, '{"name":"t3","version":"0.0.32"}\n');
    await NodeFSP.writeFile(webPath, '{"name":"web","version":"0.0.32"}\n');
    const version = await setSovereignPackageVersions({
      commit: "abcdef0123456789",
      packagePaths: [serverPath, webPath],
    });
    NodeAssert.equal(version, "0.0.32+sovereign.gabcdef012345");
    NodeAssert.equal(JSON.parse(await NodeFSP.readFile(serverPath, "utf8")).version, version);
    NodeAssert.equal(JSON.parse(await NodeFSP.readFile(webPath, "utf8")).version, version);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

NodeTest.test("derives the exact version without mutating package manifests", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-version-readonly-"));
  const serverPath = NodePath.join(directory, "server.json");
  const webPath = NodePath.join(directory, "web.json");
  try {
    const serverContents = '{"name":"t3","version":"0.0.32"}\n';
    const webContents = '{"name":"web","version":"0.0.32"}\n';
    await NodeFSP.writeFile(serverPath, serverContents);
    await NodeFSP.writeFile(webPath, webContents);

    const version = await deriveSovereignPackageVersion({
      commit: "abcdef0123456789",
      packagePaths: [serverPath, webPath],
    });

    NodeAssert.equal(version, "0.0.32+sovereign.gabcdef012345");
    NodeAssert.equal(await NodeFSP.readFile(serverPath, "utf8"), serverContents);
    NodeAssert.equal(await NodeFSP.readFile(webPath, "utf8"), webContents);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

NodeTest.test("rejects a server/client base-version split", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-version-split-"));
  const serverPath = NodePath.join(directory, "server.json");
  const webPath = NodePath.join(directory, "web.json");
  try {
    await NodeFSP.writeFile(serverPath, '{"version":"0.0.32"}\n');
    await NodeFSP.writeFile(webPath, '{"version":"0.0.33"}\n');
    await NodeAssert.rejects(
      setSovereignPackageVersions({
        commit: "abcdef0123456789",
        packagePaths: [serverPath, webPath],
      }),
      /base versions must match/u,
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
