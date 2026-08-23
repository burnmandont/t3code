import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { afterEach, vi } from "vite-plus/test";

import { SOVEREIGN_APP_CALLBACK_PATH } from "@t3tools/shared/connectAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopIdentity from "./DesktopIdentity.ts";
import { makeWithConfiguration } from "./DesktopSovereignAuth.ts";
import {
  findSovereignCallbackUrl,
  parseSovereignCallbackUrl,
  resolveProtocolRegistration,
} from "./DesktopSovereignCallback.ts";

describe("DesktopSovereignAuth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts only the exact callback route on the selected desktop origin", () => {
    const callback = `t3code-dev://app${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1&state=state-1`;

    assert.equal(parseSovereignCallbackUrl(callback, "t3code-dev"), callback);
    assert.isNull(
      parseSovereignCallbackUrl(
        `t3code-dev://other${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1`,
        "t3code-dev",
      ),
    );
    assert.isNull(
      parseSovereignCallbackUrl("t3code-dev://app/oauth/callback?code=code-1", "t3code-dev"),
    );
    assert.isNull(
      parseSovereignCallbackUrl(
        `t3code://app${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1`,
        "t3code-dev",
      ),
    );
  });

  it("finds callbacks in Windows and Linux second-instance command lines", () => {
    const callback = `t3code://app${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1&state=state-1`;
    assert.equal(findSovereignCallbackUrl(["electron", "--flag", callback], "t3code"), callback);
    assert.isNull(findSovereignCallbackUrl(["electron", "https://example.test"], "t3code"));
  });

  it("registers development callbacks against the Electron entry script", () => {
    assert.deepEqual(
      resolveProtocolRegistration({
        isDefaultApp: true,
        executablePath: "/Applications/Electron.app/Contents/MacOS/Electron",
        commandLine: ["electron", "/repo/apps/desktop/dist-electron/main.cjs"],
      }),
      {
        path: "/Applications/Electron.app/Contents/MacOS/Electron",
        args: ["/repo/apps/desktop/dist-electron/main.cjs"],
      },
    );
    assert.deepEqual(
      resolveProtocolRegistration({
        isDefaultApp: false,
        executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        commandLine: ["T3 Code"],
      }),
      {},
    );
  });

  it.effect(
    "completes a callback, restores the encrypted session, and survives corrupt state",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-desktop-auth-" });
        const listeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
        const authChanged = yield* Deferred.make<void>();
        const accessToken = (() => {
          const payload = btoa(JSON.stringify({ sub: "account-1" }))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/gu, "");
          return `header.${payload}.signature`;
        })();
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Response.json({
              access_token: accessToken,
              refresh_token: "refresh-secret-1",
              expires_in: 900,
            }),
          ),
        );

        const environment = DesktopEnvironment.DesktopEnvironment.of({
          stateDir,
          isDevelopment: true,
          appDataDirectory: stateDir,
          userDataDirName: "t3code-dev",
          legacyUserDataDirName: "T3 Code (Dev)",
          path,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
        const electronApp = {
          setPath: () => Effect.void,
          requestSingleInstanceLock: Effect.succeed(true),
          releaseSingleInstanceLock: Effect.void,
          quit: Effect.void,
          setAsDefaultProtocolClient: () => Effect.succeed(true),
          on: (eventName: string, listener: (...args: ReadonlyArray<unknown>) => void) =>
            Effect.acquireRelease(
              Effect.sync(() => listeners.set(eventName, listener)),
              () => Effect.sync(() => listeners.delete(eventName)),
            ).pipe(Effect.asVoid),
        } as unknown as ElectronApp.ElectronApp["Service"];
        const electronWindow = {
          currentMainOrFirst: Effect.succeed(Option.none()),
          reveal: () => Effect.void,
          sendAll: (channel: string) =>
            channel === "desktop:sovereign-auth-state"
              ? Deferred.succeed(authChanged, undefined).pipe(Effect.asVoid)
              : Effect.void,
        } as unknown as ElectronWindow.ElectronWindow["Service"];
        const safeStorage = ElectronSafeStorage.ElectronSafeStorage.of({
          isEncryptionAvailable: Effect.succeed(true),
          encryptString: (value) =>
            Effect.succeed(new TextEncoder().encode(`sealed:${btoa(value)}`)),
          decryptString: (value) => {
            const encoded = new TextDecoder().decode(value);
            return Effect.succeed(atob(encoded.slice("sealed:".length)));
          },
          selectedStorageBackend: Effect.succeed(Option.none()),
        });
        const identityLayer = Layer.effect(
          DesktopIdentity.DesktopIdentity,
          makeWithConfiguration({
            oauthIssuer: "https://auth.example.test/api/auth",
            oauthClientId: "t3-code",
            oauthResource: "urn:t3:relay",
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
              Layer.succeed(ElectronApp.ElectronApp, electronApp),
              Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
              Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
            ),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const identity = yield* DesktopIdentity.DesktopIdentity;
            yield* identity.configure;
            yield* identity.ready;
            const authorizeUrl = new URL(
              yield* identity.beginSovereignSignIn("t3code-dev://app/#/settings/connections"),
            );
            const callback = `t3code-dev://app${SOVEREIGN_APP_CALLBACK_PATH}?code=code-1&state=${authorizeUrl.searchParams.get("state")}`;
            const openUrl = listeners.get("open-url");
            assert.isDefined(openUrl);
            openUrl?.({ preventDefault: vi.fn() }, callback);
            yield* Deferred.await(authChanged);

            assert.deepEqual(yield* identity.getSovereignSnapshot, {
              isSignedIn: true,
              userId: "account-1",
            });
            assert.equal(yield* identity.getSovereignToken, accessToken);
            const persisted = yield* fileSystem.readFileString(
              path.join(stateDir, "sovereign-auth.json"),
            );
            assert.notInclude(persisted, accessToken);
            assert.notInclude(persisted, "refresh-secret-1");
          }).pipe(
            Effect.provide(identityLayer),
            Effect.provideService(ElectronApp.ElectronApp, electronApp),
            Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const identity = yield* DesktopIdentity.DesktopIdentity;
            yield* identity.ready;
            assert.deepEqual(yield* identity.getSovereignSnapshot, {
              isSignedIn: true,
              userId: "account-1",
            });
          }).pipe(
            Effect.provide(identityLayer),
            Effect.provideService(ElectronApp.ElectronApp, electronApp),
            Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
          ),
        );

        const authPath = path.join(stateDir, "sovereign-auth.json");
        yield* fileSystem.writeFileString(authPath, "not-json");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const identity = yield* DesktopIdentity.DesktopIdentity;
            yield* identity.ready;
            assert.deepEqual(yield* identity.getSovereignSnapshot, {
              isSignedIn: false,
              userId: null,
            });
            assert.isFalse(yield* fileSystem.exists(authPath));
          }).pipe(
            Effect.provide(identityLayer),
            Effect.provideService(ElectronApp.ElectronApp, electronApp),
            Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
