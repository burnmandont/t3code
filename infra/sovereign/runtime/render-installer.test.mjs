import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeTest from "node:test";

import { promptQuestions, renderCliWrapper } from "./bootstrap-installer.mjs";
import { renderInstaller } from "./render-installer.mjs";

const moduleSource = `const channel = "__SOVEREIGN_CHANNEL_URL__";
const releases = "__SOVEREIGN_RELEASE_BASE_URL__";
const key = "__SOVEREIGN_PUBLIC_KEY_SPKI_B64__";`;

NodeTest.test("renders a credentialless installer with an external trust root", () => {
  const installer = renderInstaller({
    moduleSource,
    channelUrl: "https://get.moondiner.com/channels/stable.json",
    releaseBaseUrl: "https://github.com/moondiner/t3-runtime/releases/download",
    publicKeySpkiB64: "MCowBQYDK2VwAyEAy9jHjuTbQWuQ9qUW5Qd8hePkpWdVqLvgBtTq9MgE0qk=",
  });
  NodeAssert.match(installer, /^#!\/bin\/sh/u);
  NodeAssert.match(installer, /https:\/\/get\.moondiner\.com\/channels\/stable\.json/u);
  NodeAssert.match(installer, /https:\/\/github\.com\/moondiner\/t3-runtime\/releases\/download/u);
  NodeAssert.doesNotMatch(installer, /SOVEREIGN_PACKAGE_TOKEN|SOVEREIGN_PACKAGE_USERNAME/u);
  NodeAssert.doesNotMatch(installer, /__SOVEREIGN_[A-Z0-9_]+__/u);
  NodeAssert.match(installer, /mktemp -d/u);
  NodeAssert.match(installer, /node_version=.*process[.]versions[.]node/u);
  NodeAssert.match(installer, /found Node \$node_version/u);
  NodeAssert.match(installer, /node "\$installer_module" "\$@" < \/dev\/tty/u);
  NodeAssert.doesNotMatch(installer, /node --input-type=module -/u);
  NodeAssert.equal(NodeChildProcess.spawnSync("sh", ["-n"], { input: installer }).status, 0);
});

NodeTest.test("the production bootstrap onboards Connect before serving", async () => {
  const moduleSource = await NodeFSP.readFile(
    new URL("./bootstrap-installer.mjs", import.meta.url),
    "utf8",
  );
  const installer = renderInstaller({
    moduleSource,
    channelUrl: "https://get.moondiner.com/channels/stable.json",
    releaseBaseUrl: "https://github.com/moondiner/t3-runtime/releases/download",
    publicKeySpkiB64: "MCowBQYDK2VwAyEAy9jHjuTbQWuQ9qUW5Qd8hePkpWdVqLvgBtTq9MgE0qk=",
  });
  NodeAssert.match(installer, /entryPath, "connect", "--headless"/u);
  NodeAssert.match(installer, /entryPath, "service", "update"/u);
  NodeAssert.match(installer, /"--user", "cat", "--quiet", "t3code[.]service"/u);
  NodeAssert.match(installer, /"--user", "is-active", "--quiet", "t3code[.]service"/u);
  NodeAssert.match(installer, /Sovereign T3 installer failed:/u);
  NodeAssert.match(installer, /Installation cancelled[.]/u);
  NodeAssert.match(installer, /Sovereign control-plane URL/u);
  NodeAssert.match(installer, /Environment display label/u);
  NodeAssert.match(installer, /[.]well-known\/t3-sovereign[.]json/u);
  NodeAssert.match(installer, /control-plane[.]json/u);
  NodeAssert.match(installer, /environment-label/u);
  NodeAssert.match(installer, /node:readline\/promises/u);
  NodeAssert.doesNotMatch(installer, /https:\/\/code[.]moondiner[.]com/u);
  NodeAssert.doesNotMatch(installer, /trusted installer's Moondiner defaults/u);
});

NodeTest.test("rejects an old Node before loading the bootstrap module", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-old-node-test-"));
  try {
    const fakeNodePath = NodePath.join(directory, "node");
    await NodeFSP.writeFile(
      fakeNodePath,
      '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 20.19.3; exit 0; fi\nexit 99\n',
      { mode: 0o755 },
    );
    const installer = renderInstaller({
      moduleSource,
      channelUrl: "https://get.moondiner.com/channels/stable.json",
      releaseBaseUrl: "https://github.com/moondiner/t3-runtime/releases/download",
      publicKeySpkiB64: "MCowBQYDK2VwAyEAy9jHjuTbQWuQ9qUW5Qd8hePkpWdVqLvgBtTq9MgE0qk=",
    });
    const result = NodeChildProcess.spawnSync("/bin/sh", {
      input: installer,
      encoding: "utf8",
      env: { PATH: directory },
    });
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stderr, /Node 22[.]16 or newer.*found Node 20[.]19[.]3/u);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

NodeTest.test("collects control-plane and label answers through one terminal session", async () => {
  const input = new NodeStream.PassThrough();
  const output = new NodeStream.PassThrough();
  let transcript = "";
  output.on("data", (chunk) => {
    transcript += chunk.toString();
    if (transcript.endsWith("Sovereign control-plane URL: ")) {
      input.write("https://control.example.test\n");
    } else if (transcript.endsWith("Environment display label: ")) {
      input.write("primary\n");
    }
  });
  await NodeAssert.doesNotReject(async () => {
    NodeAssert.deepEqual(
      await promptQuestions(["Sovereign control-plane URL: ", "Environment display label: "], {
        input,
        output,
      }),
      ["https://control.example.test", "primary"],
    );
  });
  input.end();
});

NodeTest.test("pins the validated Node executable in the installed CLI wrapper", () => {
  const wrapper = renderCliWrapper("/tmp/t3 user's state", "/opt/node 24/bin/node");
  NodeAssert.equal(
    wrapper,
    "#!/bin/sh\n" +
      "export T3CODE_HOME='/tmp/t3 user'\\''s state'\n" +
      'exec \'/opt/node 24/bin/node\' "$T3CODE_HOME/runtime/cli-launcher.mjs" "$@"\n',
  );
  NodeAssert.equal(NodeChildProcess.spawnSync("sh", ["-n"], { input: wrapper }).status, 0);
  NodeAssert.doesNotMatch(wrapper, /exec node /u);
});

NodeTest.test("rejects a bootstrap URL that could carry credentials", () => {
  NodeAssert.throws(
    () =>
      renderInstaller({
        moduleSource,
        channelUrl: "https://token@example.com/channels/stable.json",
        releaseBaseUrl: "https://github.com/moondiner/t3-runtime/releases/download",
        publicKeySpkiB64: "YWJjZA==",
      }),
    /credentialless HTTPS/u,
  );
});
