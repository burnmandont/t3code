import type { DesktopSovereignAuthSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

export class DesktopIdentityUnavailableError extends Error {
  override readonly name = "DesktopIdentityUnavailableError";

  constructor() {
    super("Sovereign desktop identity is not configured.");
  }
}

export class DesktopIdentity extends Context.Service<
  DesktopIdentity,
  {
    readonly mode: "clerk" | "sovereign";
    /** Installs pre-ready single-instance and deep-link handling. */
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
    /** Completes initialization that requires Electron's ready event. */
    readonly ready: Effect.Effect<void>;
    readonly beginSovereignSignIn: (
      returnUrl: string,
    ) => Effect.Effect<string, DesktopIdentityUnavailableError | Error>;
    readonly getSovereignSnapshot: Effect.Effect<
      DesktopSovereignAuthSnapshot,
      DesktopIdentityUnavailableError | Error
    >;
    readonly getSovereignToken: Effect.Effect<
      string | null,
      DesktopIdentityUnavailableError | Error
    >;
    readonly signOutSovereign: Effect.Effect<void, DesktopIdentityUnavailableError | Error>;
  }
>()("@t3tools/desktop/app/DesktopIdentity") {}

export const unavailableSovereignMethods = {
  beginSovereignSignIn: () => Effect.fail(new DesktopIdentityUnavailableError()),
  getSovereignSnapshot: Effect.fail(new DesktopIdentityUnavailableError()),
  getSovereignToken: Effect.fail(new DesktopIdentityUnavailableError()),
  signOutSovereign: Effect.fail(new DesktopIdentityUnavailableError()),
} satisfies Pick<
  DesktopIdentity["Service"],
  "beginSovereignSignIn" | "getSovereignSnapshot" | "getSovereignToken" | "signOutSovereign"
>;
