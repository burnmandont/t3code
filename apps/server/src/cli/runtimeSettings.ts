/* oxlint-disable t3code/no-global-process-runtime -- CLI systemd boundary. */
// @effect-diagnostics nodeBuiltinImport:off -- CLI boundary and systemd restart.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";

import {
  clearControlPlaneProfile,
  clearEnvironmentLabel,
  discoverControlPlane,
  normalizeEnvironmentLabel,
  readControlPlaneProfile,
  readEnvironmentLabel,
  writeControlPlaneProfile,
  writeEnvironmentLabel,
} from "../cloud/runtimeProfile.ts";
import {
  buildTimeHostedAppUrl,
  buildTimeOAuthClientId,
  buildTimeOAuthIssuer,
  buildTimeOAuthResource,
  buildTimeRelayUrl,
  cloudCliOAuthConfig,
  hostedAppUrlConfig,
  relayUrlConfig,
} from "../cloud/publicConfig.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { projectLocationFlags } from "./config.ts";
import { disconnectCloud, runCloudCommand } from "./connect.ts";

class RuntimeSettingError extends Schema.TaggedErrorClass<RuntimeSettingError>()(
  "RuntimeSettingError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    const detail = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not ${this.operation}.${detail}`;
  }
}

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RuntimeSettingError({ operation, cause }),
  });

function restartInstalledService(): { restarted: boolean; warning?: string } {
  if (process.platform !== "linux") return { restarted: false };
  const installed = NodeChildProcess.spawnSync(
    "systemctl",
    ["--user", "cat", "--quiet", "t3code.service"],
    { stdio: "ignore" },
  );
  if (installed.status !== 0) return { restarted: false };
  const restarted = NodeChildProcess.spawnSync(
    "systemctl",
    ["--user", "restart", "t3code.service"],
    { encoding: "utf8" },
  );
  return restarted.status === 0
    ? { restarted: true }
    : {
        restarted: false,
        warning: restarted.stderr?.trim() || "systemctl could not restart t3code.service",
      };
}

const withBaseDir = <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (baseDir: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const configuredBaseDir =
      Option.getOrUndefined(flags.baseDir)?.trim() || process.env.T3CODE_HOME?.trim();
    return yield* run(yield* resolveBaseDir(configuredBaseDir));
  });

const reportRestart = Effect.fn(function* () {
  const result = restartInstalledService();
  if (result.restarted) {
    yield* Console.log("Restarted t3code.service so the setting is live.");
  } else if (result.warning) {
    yield* Console.warn(
      `The setting was saved, but the background service was not restarted: ${result.warning}`,
    );
  } else {
    yield* Console.log("The setting will apply the next time T3 starts.");
  }
});

const controlPlaneShowCommand = Command.make("show", projectLocationFlags).pipe(
  Command.withDescription("Show the persisted sovereign control-plane profile."),
  Command.withHandler((flags) =>
    withBaseDir(flags, (baseDir) =>
      Effect.gen(function* () {
        const profile = yield* attempt("read the control-plane profile", () =>
          readControlPlaneProfile(baseDir),
        );
        if (profile === null) {
          yield* Console.log(
            "Control plane: build defaults (no persisted profile)\n" +
              `  Hosted app: ${process.env.T3CODE_HOSTED_APP_URL?.trim() || buildTimeHostedAppUrl || "not configured"}\n` +
              `  OAuth issuer: ${process.env.T3CODE_OAUTH_ISSUER?.trim() || buildTimeOAuthIssuer || "not configured"}\n` +
              `  Relay: ${process.env.T3CODE_RELAY_URL?.trim() || buildTimeRelayUrl || "not configured"}`,
          );
          return;
        }
        yield* Console.log(
          [
            `Control plane: ${profile.origin}`,
            `  Hosted app: ${profile.hostedAppUrl}`,
            `  OAuth issuer: ${profile.oauthIssuer}`,
            `  OAuth client: ${profile.oauthClientId}`,
            `  OAuth resource: ${profile.oauthResource}`,
            `  Relay: ${profile.relayUrl}`,
          ].join("\n"),
        );
      }),
    ),
  ),
);

const controlPlaneSetCommand = Command.make("set", {
  ...projectLocationFlags,
  origin: Argument.string("origin"),
}).pipe(
  Command.withDescription("Discover, validate, and persist a sovereign control plane."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const { baseDir } = yield* ServerConfig.ServerConfig;
        const discovered = yield* attempt("discover the control plane", () =>
          discoverControlPlane(flags.origin),
        );
        const currentHostedAppUrl = yield* hostedAppUrlConfig;
        const currentRelayUrl = yield* relayUrlConfig;
        const currentOAuth = yield* cloudCliOAuthConfig;
        const endpointsChanged =
          currentHostedAppUrl !== discovered.hostedAppUrl ||
          currentRelayUrl !== discovered.relayUrl ||
          currentOAuth.provider !== "sovereign" ||
          currentOAuth.tokenEndpoint !== `${discovered.oauthIssuer}/oauth2/token` ||
          currentOAuth.clientId !== discovered.oauthClientId ||
          currentOAuth.resource !== discovered.oauthResource;
        if (endpointsChanged) {
          yield* disconnectCloud({ clearAuthorization: true });
        }
        yield* attempt("save the control-plane profile", () =>
          writeControlPlaneProfile(baseDir, discovered),
        );
        yield* Console.log(
          endpointsChanged
            ? `Saved control plane ${discovered.origin}.\nSign in again with \`t3 connect --headless\`.`
            : `Saved control plane ${discovered.origin}. Existing authorization remains valid.`,
        );
        yield* reportRestart();
      }),
    ),
  ),
);

const controlPlaneResetCommand = Command.make("reset", projectLocationFlags).pipe(
  Command.withDescription("Remove the persisted profile and return to this build's defaults."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const { baseDir } = yield* ServerConfig.ServerConfig;
        const existing = yield* attempt("read the control-plane profile", () =>
          readControlPlaneProfile(baseDir),
        );
        const defaultsMatch =
          existing !== null &&
          existing.hostedAppUrl === buildTimeHostedAppUrl &&
          existing.relayUrl === buildTimeRelayUrl &&
          existing.oauthIssuer === buildTimeOAuthIssuer &&
          existing.oauthClientId === buildTimeOAuthClientId &&
          existing.oauthResource === buildTimeOAuthResource;
        const authorizationCleared = existing !== null && !defaultsMatch;
        if (authorizationCleared) {
          yield* disconnectCloud({ clearAuthorization: true });
        }
        yield* attempt("remove the control-plane profile", () => clearControlPlaneProfile(baseDir));
        yield* Console.log(
          authorizationCleared
            ? "Removed the persisted control-plane profile. Sign in again with `t3 connect --headless`."
            : "Removed the persisted control-plane profile. Existing authorization remains valid.",
        );
        yield* reportRestart();
      }),
    ),
  ),
);

export const controlPlaneCommand = Command.make("control-plane").pipe(
  Command.withDescription("Configure the sovereign account, OAuth, and relay control plane."),
  Command.withSubcommands([
    controlPlaneShowCommand,
    controlPlaneSetCommand,
    controlPlaneResetCommand,
  ]),
);

const environmentLabelShowCommand = Command.make("show", projectLocationFlags).pipe(
  Command.withHandler((flags) =>
    withBaseDir(flags, (baseDir) =>
      Effect.gen(function* () {
        const label = yield* attempt("read the environment label", () =>
          readEnvironmentLabel(baseDir),
        );
        yield* Console.log(
          label === null
            ? `Environment label: automatic (${NodeOS.hostname()})`
            : `Environment label: ${label}`,
        );
      }),
    ),
  ),
);

const environmentLabelSetCommand = Command.make("set", {
  ...projectLocationFlags,
  label: Argument.string("label"),
}).pipe(
  Command.withHandler((flags) =>
    withBaseDir(flags, (baseDir) =>
      Effect.gen(function* () {
        const label = normalizeEnvironmentLabel(flags.label);
        yield* attempt("save the environment label", () => writeEnvironmentLabel(baseDir, label));
        yield* Console.log(
          `Environment label saved as '${label}'. The environment ID is unchanged.`,
        );
        yield* reportRestart();
      }),
    ),
  ),
);

const environmentLabelResetCommand = Command.make("reset", projectLocationFlags).pipe(
  Command.withHandler((flags) =>
    withBaseDir(flags, (baseDir) =>
      Effect.gen(function* () {
        yield* attempt("remove the environment label", () => clearEnvironmentLabel(baseDir));
        yield* Console.log(
          "Environment label reset to automatic host detection. The environment ID is unchanged.",
        );
        yield* reportRestart();
      }),
    ),
  ),
);

const environmentLabelCommand = Command.make("label").pipe(
  Command.withDescription("Manage this environment's relay-visible display label."),
  Command.withSubcommands([
    environmentLabelShowCommand,
    environmentLabelSetCommand,
    environmentLabelResetCommand,
  ]),
);

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription("Configure this T3 execution environment."),
  Command.withSubcommands([environmentLabelCommand]),
);
