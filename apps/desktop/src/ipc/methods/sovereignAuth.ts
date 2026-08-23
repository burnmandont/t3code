import {
  DesktopSovereignAuthBeginInputSchema,
  DesktopSovereignAuthSignOutResultSchema,
  DesktopSovereignAuthSnapshotSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIdentity from "../../app/DesktopIdentity.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const beginSovereignSignIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SOVEREIGN_AUTH_BEGIN_CHANNEL,
  payload: DesktopSovereignAuthBeginInputSchema,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.sovereignAuth.begin")(function* (input) {
    const identity = yield* DesktopIdentity.DesktopIdentity;
    return yield* identity.beginSovereignSignIn(input);
  }),
});

export const getSovereignAuthSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SOVEREIGN_AUTH_GET_SNAPSHOT_CHANNEL,
  payload: Schema.Void,
  result: DesktopSovereignAuthSnapshotSchema,
  handler: Effect.fn("desktop.ipc.sovereignAuth.snapshot")(function* () {
    const identity = yield* DesktopIdentity.DesktopIdentity;
    return yield* identity.getSovereignSnapshot;
  }),
});

export const getSovereignAuthToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SOVEREIGN_AUTH_GET_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.sovereignAuth.token")(function* () {
    const identity = yield* DesktopIdentity.DesktopIdentity;
    return yield* identity.getSovereignToken;
  }),
});

export const signOutSovereignAuth = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SOVEREIGN_AUTH_SIGN_OUT_CHANNEL,
  payload: Schema.Void,
  result: DesktopSovereignAuthSignOutResultSchema,
  handler: Effect.fn("desktop.ipc.sovereignAuth.signOut")(function* () {
    const identity = yield* DesktopIdentity.DesktopIdentity;
    return yield* identity.signOutSovereign;
  }),
});
