import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, 'exec "$T3_CLI_PATH" "$@"');
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, "require_installed_t3_cli npx --yes --package 't3@latest'");
    assert.include(script, "require_installed_t3_cli npm exec --yes --package 't3@latest'");
    assert.include(script, "npm produced no t3 executable");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(
      script,
      "require_installed_t3_cli npx --yes --package 't3@nightly; touch /tmp/t3-owned'",
    );
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.notInclude(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.include(buildRemoteLaunchScript(), "discover_running_runtime()");
    assert.include(buildRemoteLaunchScript(), "systemctl --user show t3code.service");
    assert.include(buildRemoteLaunchScript(), "t3code.service/cgroup.procs");
    assert.include(
      buildRemoteLaunchScript(),
      "SERVICE_BASE_DIR=\"$(sed -n 's/^Environment=T3CODE_HOME=//p'",
    );
    assert.include(buildRemoteLaunchScript(), `''|*[!0-9]*|0) SERVICE_PID=""`);
    assert.include(
      buildRemoteLaunchScript(),
      "The remote t3code.service is active, but its T3 runtime could not be discovered.",
    );
    assert.notInclude(buildRemoteLaunchScript(), 'fs.readdirSync("/proc")');
    assert.include(buildRemoteLaunchScript(), "knownBaseDirPath");
    assert.include(buildRemoteLaunchScript(), '"server-runtime.json"');
    assert.include(buildRemoteLaunchScript(), "addBaseDirFromPid(servicePid, true);");
    assert.include(buildRemoteLaunchScript(), "addBaseDir(serviceBaseDir);");
    assert.include(buildRemoteLaunchScript(), "isDescendantOf(pid, servicePid)");
    assert.include(buildRemoteLaunchScript(), 'origin.protocol !== "http:"');
    assert.notInclude(buildRemoteLaunchScript(), "AbortSignal.timeout(2500)");
    assert.include(buildRemoteLaunchScript(), "Existing remote T3 server did not become ready");
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript(), 'wait_ready "60000"');
    assert.include(buildRemoteLaunchScript(), 'if [ -s "$LOG_FILE" ]; then');
    assert.include(buildRemoteLaunchScript(), "It wrote nothing to %s");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" pair --base-dir "$PAIRING_BASE_DIR" >"$PAIR_OUTPUT_FILE" 2>&1',
    );
    assert.include(buildRemotePairingScript(target), 'if [ -z "$PAIRING_BASE_DIR" ]');
    assert.notInclude(buildRemotePairingScript(target), '"$RUNNER_FILE" pair >');
    assert.include(buildRemotePairingScript(target), "grep -q 'database is locked'");
    assert.include(buildRemotePairingScript(target), 'while [ "$PAIR_ATTEMPT" -lt 5 ]');
    assert.include(buildRemotePairingScript(target), 'RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"');
    assert.include(buildRemotePairingScript(target), 'cat >"$RUNNER_NEXT"');
    assert.include(buildRemotePairingScript(target), 'mv -f "$RUNNER_NEXT" "$RUNNER_FILE"');
    assert.notInclude(buildRemotePairingScript(target), 'cat >"$RUNNER_FILE"');
    for (const script of [
      buildRemoteLaunchScript(),
      buildRemotePairingScript(target),
      buildRemoteStopScript(target),
    ]) {
      assert.include(script, "acquire_state_lock()");
      assert.include(script, "release_state_lock()");
      assert.include(script, "flock -w 45 9");
      assert.include(script, 'ln "$STATE_LOCK_OWNER_FILE" "$STATE_LOCK_LINK"');
      assert.include(script, 'kill -0 "$STATE_LOCK_OWNER_PID"');
      assert.include(script, 'STATE_LOCK_WAIT_COUNT" -ge 450');
      assert.include(script, "acquire_state_lock");
    }
    assert.include(buildRemotePairingScript(target), 'line.startsWith("Token: ")');
    assert.include(buildRemotePairingScript(target), 'BASE_DIR_FILE="$STATE_DIR/base-dir"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(buildRemoteStopScript(target), 'if [ "$REMOTE_MANAGED" = "external" ]');
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"');
    assert.include(buildRemoteLaunchScript(), "< /dev/null 9>&- &");
    assert.include(buildRemoteLaunchScript(), 'mv "$DISCOVERED_BASE_DIR_FILE" "$BASE_DIR_FILE"');
    assert.include(buildRemoteLaunchScript(), 'if [ -n "$LAUNCHED_PID" ]; then');
    assert.notInclude(
      buildRemoteLaunchScript(),
      'discover_running_runtime() {\n  rm -f "$BASE_DIR_FILE"',
    );
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf("addBaseDirFromPid(servicePid, true);"),
      buildRemoteLaunchScript().indexOf("addBaseDir(environmentBaseDir);"),
    );
    assert.match(
      buildRemoteLaunchScript(),
      /Existing remote T3 server did not become ready[^]*?exit 1\n  fi\nfi/u,
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it.effect("does not launch a competing server when an authoritative runtime is unready", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-authoritative-" });
      const baseDir = path.join(home, "sovereign");
      const runtimeDir = path.join(baseDir, "userdata");
      const stateKey = "authoritative-runtime-test";

      yield* fs.makeDirectory(runtimeDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(runtimeDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid},"port":65534,"origin":"http://127.0.0.1:65534","startedAt":"2026-08-25T00:00:00.000Z"}\n`,
      );

      const script = buildRemoteLaunchScript()
        .replace('if wait_ready "20000"; then', 'if wait_ready "0"; then')
        .replace(
          'REMOTE_PORT="$(pick_port)" || true',
          "printf 'COMPETING_LAUNCH_REACHED\\n' >&2; exit 42",
        );
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-s", "--", stateKey], {
          env: { HOME: home, T3CODE_HOME: baseDir },
          extendEnv: true,
        }),
      );
      yield* Stream.make(new TextEncoder().encode(script)).pipe(Stream.run(handle.stdin));
      const [stderr, exitCode] = yield* Effect.all(
        [
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (accumulator, chunk) => accumulator + chunk,
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(exitCode, 1, stderr);
      assert.include(stderr, "Existing remote T3 server did not become ready");
      assert.notInclude(stderr, "COMPETING_LAUNCH_REACHED");
      assert.isFalse(yield* fs.exists(path.join(home, ".t3", "ssh-launch", stateKey, "pid")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not launch when an active user service has no discoverable runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-service-metadata-" });
      const baseDir = path.join(home, "sovereign");
      const runtimeDir = path.join(baseDir, "userdata");
      const stateKey = "missing-service-metadata-test";

      yield* fs.makeDirectory(runtimeDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(runtimeDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid},"port":65534,"origin":"http://127.0.0.1:65534","startedAt":"2026-08-25T00:00:00.000Z"}\n`,
      );
      const serviceHandle = yield* spawner.spawn(
        ChildProcess.make("node", ["-e", "setInterval(() => {}, 1000)"], {
          env: { HOME: home, T3CODE_HOME: baseDir },
          extendEnv: true,
        }),
      );
      const script = buildRemoteLaunchScript()
        .replace(
          `SERVICE_PID=""
if command -v systemctl >/dev/null 2>&1; then
  SERVICE_PID="$(systemctl --user show t3code.service --property=MainPID --value 2>/dev/null || true)"
fi`,
          `SERVICE_PID="${Number(serviceHandle.pid)}"`,
        )
        .replace(
          'REMOTE_PORT="$(pick_port)" || true',
          "printf 'COMPETING_LAUNCH_REACHED\\n' >&2; exit 42",
        );
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-s", "--", stateKey], {
          env: { HOME: home, T3CODE_HOME: undefined },
          extendEnv: true,
        }),
      );
      yield* Stream.make(new TextEncoder().encode(script)).pipe(Stream.run(handle.stdin));
      const [stderr, exitCode] = yield* Effect.all(
        [
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (accumulator, chunk) => accumulator + chunk,
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      yield* serviceHandle.kill();

      assert.equal(exitCode, 1, stderr);
      assert.include(stderr, "t3code.service is active");
      assert.notInclude(stderr, "COMPETING_LAUNCH_REACHED");
      assert.isFalse(yield* fs.exists(path.join(home, ".t3", "ssh-launch", stateKey, "pid")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers the generated service home when the user systemd bus is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-service-unit-" });
      const baseDir = path.join(home, "sovereign");
      const runtimeDir = path.join(baseDir, "userdata");
      const unitDir = path.join(home, ".config", "systemd", "user");
      const stateKey = "service-unit-runtime-test";

      yield* fs.makeDirectory(runtimeDir, { recursive: true });
      yield* fs.makeDirectory(unitDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(runtimeDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid},"port":65534,"origin":"http://127.0.0.1:65534","startedAt":"2026-08-25T00:00:00.000Z"}\n`,
      );
      yield* fs.writeFileString(
        path.join(unitDir, "t3code.service"),
        `[Service]\nEnvironment=T3CODE_HOME=${baseDir}\n`,
      );

      const script = buildRemoteLaunchScript()
        .replace('if wait_ready "20000"; then', 'if wait_ready "0"; then')
        .replace(
          'REMOTE_PORT="$(pick_port)" || true',
          "printf 'COMPETING_LAUNCH_REACHED\\n' >&2; exit 42",
        );
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-s", "--", stateKey], {
          env: { HOME: home, T3CODE_HOME: undefined },
          extendEnv: true,
        }),
      );
      yield* Stream.make(new TextEncoder().encode(script)).pipe(Stream.run(handle.stdin));
      const [stderr, exitCode] = yield* Effect.all(
        [
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (accumulator, chunk) => accumulator + chunk,
            ),
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(exitCode, 1, stderr);
      assert.include(stderr, "Existing remote T3 server did not become ready");
      assert.notInclude(stderr, "COMPETING_LAUNCH_REACHED");
      assert.isFalse(yield* fs.exists(path.join(home, ".t3", "ssh-launch", stateKey, "pid")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("embeds syntactically valid Node scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    for (const script of [buildRemoteLaunchScript(), buildRemotePairingScript(target)]) {
      const embeddedScripts = [...script.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/gu)];
      assert.isAbove(embeddedScripts.length, 0);
      for (const match of embeddedScripts) {
        assert.doesNotThrow(() => Function(match[1]!));
      }
    }
  });

  it.effect("emits syntactically valid remote shell scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const script of [
        buildRemoteLaunchScript(),
        buildRemotePairingScript(target),
        buildRemoteStopScript(target),
      ]) {
        assert.notMatch(script, /@@[A-Z0-9_]+@@/u);
        const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-n"]));
        yield* Stream.make(new TextEncoder().encode(script)).pipe(Stream.run(handle.stdin));
        const [stderr, exitCode] = yield* Effect.all(
          [
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (accumulator, chunk) => accumulator + chunk,
              ),
            ),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(exitCode, 0, stderr);
      }
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect.each(["successful stop", "failed stop"] as const)(
    "closes the tunnel scope and starts fresh after a %s",
    (mode) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let tunnelKillCount = 0;
      let stopCommandCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          spawnedCommands.push(args);
          if (args.includes("-N")) {
            return makeRunningProcess(() => {
              tunnelKillCount += 1;
            });
          }
          if (args.includes("sh") && args.includes("--")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("sh")) {
            stopCommandCount += 1;
            if (mode === "failed stop" && stopCommandCount === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(
                  new TextEncoder().encode("Remote T3 server did not stop within 2 seconds.\n"),
                ),
              };
            }
            return makeSuccessfulProcess('{"stopped":true}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer(),
      );
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;

      return Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;

        const first = yield* manager.ensureEnvironment(target);
        assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
        const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
        assert.isDefined(firstTunnelArgs);
        assert.include(firstTunnelArgs, "ControlMaster=no");
        assert.include(firstTunnelArgs, "ControlPath=none");
        assert.include(firstTunnelArgs, "ControlPersist=no");

        const disconnected = yield* Effect.result(manager.disconnectEnvironment(target));
        if (mode === "failed stop") {
          assert.isTrue(Result.isFailure(disconnected));
          if (Result.isFailure(disconnected)) {
            assert.instanceOf(disconnected.failure, SshCommandError);
            assert.equal(
              disconnected.failure.message,
              "Remote T3 server did not stop within 2 seconds.",
            );
          }
        } else {
          assert.isTrue(Result.isSuccess(disconnected));
        }
        assert.equal(tunnelKillCount, 1);
        assert.equal(stopCommandCount, 1);

        if (mode === "failed stop") {
          yield* manager.disconnectEnvironment(target);
          assert.equal(tunnelKillCount, 1);
          assert.equal(stopCommandCount, 2);
        }

        yield* manager.ensureEnvironment(target);

        assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
        assert.equal(tunnelKillCount, 1);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(tunnelKillCount, 2);
            assert.equal(stopCommandCount, mode === "failed stop" ? 3 : 2);
          }),
        ),
      );
    },
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.includes("--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshPasswordPrompt.disabledLayer,
          SshEnvironmentManager.layer(),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
  it.effect("opens native SOCKS forwarding and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
      assert.equal(first.forwardingSocksPort, 41_774);
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");
      assert.include(firstTunnelArgs, "-D");
      assert.include(firstTunnelArgs, "127.0.0.1:41774");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("serializes pairing commands for concurrent ensures of one SSH target", () => {
    let activePairingCommands = 0;
    let maximumActivePairingCommands = 0;
    let pairingCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {});
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"external"}\n');
        }
        if (args.includes("sh")) {
          pairingCommandCount += 1;
          const stdout = Stream.make(
            new TextEncoder().encode(`{"credential":"PAIR-${pairingCommandCount}"}\n`),
          );
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(200 + pairingCommandCount),
            stdout,
            stderr: Stream.empty,
            all: stdout,
            exitCode: Effect.gen(function* () {
              activePairingCommands += 1;
              maximumActivePairingCommands = Math.max(
                maximumActivePairingCommands,
                activePairingCommands,
              );
              yield* Effect.yieldNow;
              activePairingCommands -= 1;
              return ChildProcessSpawner.ExitCode(0);
            }),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const results = yield* Effect.all(
        [
          manager.ensureEnvironment(target, { issuePairingToken: true }),
          manager.ensureEnvironment(target, { issuePairingToken: true }),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(pairingCommandCount, 2);
      assert.equal(maximumActivePairingCommands, 1);
      assert.deepEqual(results.map((result) => result.pairingToken).toSorted(), [
        "PAIR-1",
        "PAIR-2",
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
