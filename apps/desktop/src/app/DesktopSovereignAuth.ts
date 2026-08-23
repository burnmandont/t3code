import {
  SOVEREIGN_APP_CALLBACK_PATH,
  SOVEREIGN_CONNECT_OAUTH_SCOPES,
} from "@t3tools/shared/connectAuth";
import {
  makeSovereignAuthClient,
  SOVEREIGN_TOKEN_STORAGE_KEY,
  SOVEREIGN_TRANSACTION_STORAGE_KEY,
} from "@t3tools/shared/sovereignAuth";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopIdentity from "./DesktopIdentity.ts";
import {
  findSovereignCallbackUrl,
  parseSovereignCallbackUrl,
  resolveProtocolRegistration,
} from "./DesktopSovereignCallback.ts";

declare const __T3CODE_BUILD_OAUTH_ISSUER__: string | undefined;
declare const __T3CODE_BUILD_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_OAUTH_RESOURCE__: string | undefined;

const oauthIssuer =
  typeof __T3CODE_BUILD_OAUTH_ISSUER__ === "undefined"
    ? ""
    : (__T3CODE_BUILD_OAUTH_ISSUER__?.trim() ?? "");
const oauthClientId =
  typeof __T3CODE_BUILD_OAUTH_CLIENT_ID__ === "undefined"
    ? ""
    : (__T3CODE_BUILD_OAUTH_CLIENT_ID__?.trim() ?? "");
const oauthResource =
  typeof __T3CODE_BUILD_OAUTH_RESOURCE__ === "undefined"
    ? ""
    : (__T3CODE_BUILD_OAUTH_RESOURCE__?.trim() ?? "");

export const desktopSovereignIdentitySelected = Boolean(
  oauthIssuer || oauthClientId || oauthResource,
);

const EncryptedAuthDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedState: Schema.String,
});
const decodeEncryptedAuthDocument = Schema.decodeUnknownOption(
  Schema.fromJsonString(EncryptedAuthDocument),
);
const encodeEncryptedAuthDocument = Schema.encodeSync(Schema.fromJsonString(EncryptedAuthDocument));

const AuthState = Schema.Struct({
  token: Schema.NullOr(Schema.String),
  transaction: Schema.NullOr(Schema.String),
});
type AuthState = typeof AuthState.Type;
const decodeAuthState = Schema.decodeUnknownOption(Schema.fromJsonString(AuthState));
const encodeAuthState = Schema.encodeSync(Schema.fromJsonString(AuthState));

export class DesktopSovereignAuthError extends Schema.TaggedErrorClass<DesktopSovereignAuthError>()(
  "DesktopSovereignAuthError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop sovereign authentication failed during ${this.operation}.`;
  }
}
const isDesktopSovereignAuthError = Schema.is(DesktopSovereignAuthError);

function memoryStorage(values: Map<string, string>): Storage {
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

export interface DesktopSovereignAuthConfiguration {
  readonly oauthIssuer: string;
  readonly oauthClientId: string;
  readonly oauthResource: string;
}

function requireConfiguration(): DesktopSovereignAuthConfiguration {
  if (!oauthIssuer || !oauthClientId || !oauthResource) {
    throw new DesktopSovereignAuthError({
      operation: "validate-configuration",
      cause: new Error(
        "T3CODE_OAUTH_ISSUER, T3CODE_OAUTH_CLIENT_ID, and T3CODE_OAUTH_RESOURCE must be configured together.",
      ),
    });
  }
  return { oauthIssuer, oauthClientId, oauthResource };
}

export const makeWithConfiguration = (config: DesktopSovereignAuthConfiguration) =>
  Effect.gen(function* () {
    const normalizedIssuer = config.oauthIssuer.replace(/\/+$/u, "");
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const fileSystem = yield* FileSystem.FileSystem;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
    const appOrigin = ElectronProtocol.getDesktopOrigin(environment.isDevelopment);
    const redirectUri = `${appOrigin}${SOVEREIGN_APP_CALLBACK_PATH}`;
    const authPath = environment.path.join(environment.stateDir, "sovereign-auth.json");
    const tempAuthPath = `${authPath}.${process.pid}.tmp`;
    const values = new Map<string, string>();
    const storage = memoryStorage(values);
    const operationMutex = yield* Semaphore.make(1);
    const initialized = yield* Ref.make(false);
    const ready = yield* Ref.make(false);
    const pendingCallbacks = yield* Ref.make<ReadonlyArray<string>>([]);

    const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath;
    yield* electronApp.setPath("userData", userDataPath);
    const isPrimaryInstance = yield* electronApp.requestSingleInstanceLock;
    yield* Effect.addFinalizer(() =>
      isPrimaryInstance ? electronApp.releaseSingleInstanceLock : Effect.void,
    );

    const client = makeSovereignAuthClient(
      {
        appOrigin,
        appProtocol: `${scheme}:`,
        appHost: ElectronProtocol.DESKTOP_HOST,
        authorizationEndpoint: `${normalizedIssuer}/oauth2/authorize`,
        tokenEndpoint: `${normalizedIssuer}/oauth2/token`,
        userInfoEndpoint: `${normalizedIssuer}/oauth2/userinfo`,
        revocationEndpoint: `${normalizedIssuer}/oauth2/revoke`,
        clientId: config.oauthClientId,
        redirectUri,
        resource: config.oauthResource,
        scopes: SOVEREIGN_CONNECT_OAUTH_SCOPES,
      },
      {
        tokenStorage: storage,
        transactionStorage: storage,
        fetch: globalThis.fetch,
        crypto: globalThis.crypto,
      },
    );

    const loadEncryptedState = Effect.gen(function* () {
      if (yield* Ref.get(initialized)) return;
      const exists = yield* fileSystem
        .exists(authPath)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopSovereignAuthError({ operation: "inspect-state", cause }),
          ),
        );
      if (exists) {
        const encoded = yield* fileSystem
          .readFileString(authPath)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopSovereignAuthError({ operation: "read-state", cause }),
            ),
          );
        const document = decodeEncryptedAuthDocument(encoded);
        if (Option.isNone(document)) {
          return yield* new DesktopSovereignAuthError({
            operation: "decode-state-document",
            cause: new Error("Invalid sovereign auth state document."),
          });
        }
        const decrypted = yield* safeStorage
          .decryptString(Uint8Array.from(Buffer.from(document.value.encryptedState, "base64")))
          .pipe(
            Effect.mapError(
              (cause) => new DesktopSovereignAuthError({ operation: "decrypt-state", cause }),
            ),
          );
        const state = decodeAuthState(decrypted);
        if (Option.isNone(state)) {
          return yield* new DesktopSovereignAuthError({
            operation: "decode-state",
            cause: new Error("Invalid sovereign auth state."),
          });
        }
        if (state.value.token !== null) values.set(SOVEREIGN_TOKEN_STORAGE_KEY, state.value.token);
        if (state.value.transaction !== null) {
          values.set(SOVEREIGN_TRANSACTION_STORAGE_KEY, state.value.transaction);
        }
      }
      yield* Ref.set(initialized, true);
    });

    const load = loadEncryptedState.pipe(
      Effect.catchIf(
        (error) =>
          error.operation === "decode-state-document" ||
          error.operation === "decrypt-state" ||
          error.operation === "decode-state",
        (error) =>
          Effect.logWarning(
            "Discarding unreadable sovereign desktop identity state and continuing signed out.",
            { operation: error.operation },
          ).pipe(
            Effect.andThen(fileSystem.remove(authPath, { force: true }).pipe(Effect.ignore)),
            Effect.andThen(
              Effect.sync(() => {
                values.clear();
              }),
            ),
            Effect.andThen(Ref.set(initialized, true)),
          ),
      ),
    );

    const persist = Effect.gen(function* () {
      const encryptionAvailable = yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSovereignAuthError({ operation: "check-encryption-availability", cause }),
        ),
      );
      if (!encryptionAvailable) {
        return yield* new DesktopSovereignAuthError({
          operation: "check-encryption-availability",
          cause: new Error("Electron safeStorage is unavailable."),
        });
      }
      const plaintext = encodeAuthState({
        token: values.get(SOVEREIGN_TOKEN_STORAGE_KEY) ?? null,
        transaction: values.get(SOVEREIGN_TRANSACTION_STORAGE_KEY) ?? null,
      });
      const encrypted = yield* safeStorage
        .encryptString(plaintext)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopSovereignAuthError({ operation: "encrypt-state", cause }),
          ),
        );
      yield* fileSystem
        .makeDirectory(environment.path.dirname(authPath), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopSovereignAuthError({ operation: "create-state-directory", cause }),
          ),
        );
      yield* Effect.gen(function* () {
        yield* fileSystem
          .writeFileString(
            tempAuthPath,
            `${encodeEncryptedAuthDocument({
              version: 1,
              encryptedState: Buffer.from(encrypted).toString("base64"),
            })}\n`,
            { mode: 0o600 },
          )
          .pipe(
            Effect.mapError(
              (cause) => new DesktopSovereignAuthError({ operation: "write-state", cause }),
            ),
          );
        yield* fileSystem
          .rename(tempAuthPath, authPath)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopSovereignAuthError({ operation: "replace-state", cause }),
            ),
          );
      }).pipe(
        Effect.ensuring(fileSystem.remove(tempAuthPath, { force: true }).pipe(Effect.ignore)),
      );
    });

    const initialize = operationMutex.withPermit(load);
    const hydrateUserInfo = Effect.tryPromise({
      try: () => client.getUserInfo(),
      catch: (cause) => new DesktopSovereignAuthError({ operation: "get-user-info", cause }),
    }).pipe(
      Effect.tap(() => persist),
      Effect.catch((error) =>
        Effect.logWarning("Could not refresh sovereign desktop account identity.", { error }),
      ),
    );
    const snapshot = operationMutex.withPermit(
      Effect.gen(function* () {
        yield* load;
        const current = client.snapshot();
        if (current.isSignedIn && current.email === null && current.name === null) {
          yield* hydrateUserInfo;
        }
        return client.snapshot();
      }),
    );
    const notify = snapshot.pipe(
      Effect.flatMap((next) =>
        electronWindow.sendAll(IpcChannels.SOVEREIGN_AUTH_STATE_CHANNEL, next),
      ),
    );

    const completeCallback = (callbackUrl: string) =>
      operationMutex
        .withPermit(
          Effect.gen(function* () {
            yield* load;
            yield* Effect.tryPromise({
              try: () => client.completeSignIn(callbackUrl),
              catch: (cause) =>
                new DesktopSovereignAuthError({ operation: "complete-sign-in", cause }),
            });
            yield* hydrateUserInfo;
            yield* persist;
          }),
        )
        .pipe(Effect.andThen(notify));

    return DesktopIdentity.DesktopIdentity.of({
      mode: "sovereign",
      clerkFrontendApiHostname: undefined,
      configure: Effect.gen(function* () {
        if (!isPrimaryInstance) {
          yield* electronApp.quit;
          return yield* Effect.interrupt;
        }
        const context = yield* Effect.context<never>();
        const runPromise = Effect.runPromiseWith(context);
        const reveal = electronWindow.currentMainOrFirst.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (window) => electronWindow.reveal(window),
            }),
          ),
        );
        const accept = (rawUrl: unknown) => {
          const callbackUrl = parseSovereignCallbackUrl(rawUrl, scheme);
          if (callbackUrl === null) return;
          const process = Effect.gen(function* () {
            if (!(yield* Ref.get(ready))) {
              yield* Ref.update(pendingCallbacks, (queued) => [...queued, callbackUrl]);
              return;
            }
            yield* completeCallback(callbackUrl);
            yield* reveal;
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not complete sovereign desktop sign-in.", { error }),
            ),
          );
          void runPromise(process);
        };

        yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: unknown) => {
          event.preventDefault();
          accept(url);
        });
        yield* electronApp.on(
          "second-instance",
          (_event: unknown, commandLine: ReadonlyArray<unknown>) => {
            accept(findSovereignCallbackUrl(commandLine, scheme));
            void runPromise(reveal);
          },
        );
        accept(findSovereignCallbackUrl(process.argv, scheme));

        const registration = resolveProtocolRegistration({
          isDefaultApp: process.defaultApp === true,
          executablePath: process.execPath,
          commandLine: process.argv,
        });
        const registered = yield* electronApp.setAsDefaultProtocolClient(
          scheme,
          registration.path,
          registration.args,
        );
        if (!registered) {
          yield* Effect.logWarning("Could not register sovereign OAuth callback protocol.", {
            scheme,
          });
        }
      }).pipe(Effect.withSpan("desktop.sovereignAuth.configure")),
      ready: Effect.gen(function* () {
        yield* initialize;
        yield* Ref.set(ready, true);
        const queued = yield* Ref.getAndSet(pendingCallbacks, []);
        for (const callbackUrl of queued) {
          yield* completeCallback(callbackUrl).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not complete queued sovereign desktop sign-in.", { error }),
            ),
          );
        }
      }).pipe(Effect.withSpan("desktop.sovereignAuth.ready"), Effect.orDie),
      beginSovereignSignIn: (input) =>
        operationMutex.withPermit(
          Effect.gen(function* () {
            yield* load;
            const authorizationUrl = yield* Effect.tryPromise({
              try: () =>
                input.prompt === undefined
                  ? client.beginSignIn(input.returnUrl)
                  : client.beginSignIn(input.returnUrl, { prompt: input.prompt }),
              catch: (cause) =>
                new DesktopSovereignAuthError({ operation: "begin-sign-in", cause }),
            });
            yield* persist;
            return authorizationUrl;
          }),
        ),
      getSovereignSnapshot: snapshot,
      getSovereignToken: operationMutex.withPermit(
        Effect.gen(function* () {
          yield* load;
          const token = yield* Effect.tryPromise({
            try: () => client.getToken(),
            catch: (cause) => new DesktopSovereignAuthError({ operation: "get-token", cause }),
          });
          yield* persist;
          return token;
        }),
      ),
      signOutSovereign: operationMutex
        .withPermit(
          Effect.gen(function* () {
            yield* load;
            const result = yield* Effect.promise(() => client.signOut());
            yield* persist;
            return result;
          }),
        )
        .pipe(Effect.tap(() => notify)),
    });
  });

export const make = Effect.try({
  try: requireConfiguration,
  catch: (cause) =>
    isDesktopSovereignAuthError(cause)
      ? cause
      : new DesktopSovereignAuthError({ operation: "validate-configuration", cause }),
}).pipe(Effect.flatMap(makeWithConfiguration));

export const layer = Layer.effect(DesktopIdentity.DesktopIdentity, make);
