import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TcpPortForwardHost = Schema.Literal("127.0.0.1");
export type TcpPortForwardHost = typeof TcpPortForwardHost.Type;

export const TcpPort = PortSchema;
export type TcpPort = typeof TcpPort.Type;

export const TcpPortForwardTicketRequest = Schema.Struct({
  remoteHost: TcpPortForwardHost,
  remotePort: TcpPort,
});
export type TcpPortForwardTicketRequest = typeof TcpPortForwardTicketRequest.Type;

export const TcpPortForwardTicketResult = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type TcpPortForwardTicketResult = typeof TcpPortForwardTicketResult.Type;

export const DesktopPortForwardId = Schema.String.pipe(Schema.brand("DesktopPortForwardId"));
export type DesktopPortForwardId = typeof DesktopPortForwardId.Type;

export const DesktopPortForwardStatus = Schema.Literals(["running", "failed"]);
export type DesktopPortForwardStatus = typeof DesktopPortForwardStatus.Type;

export const DesktopPortForwardCreateInput = Schema.Struct({
  environmentId: EnvironmentId,
  remoteHost: TcpPortForwardHost,
  remotePort: TcpPort,
  localPort: Schema.optionalKey(TcpPort),
});
export type DesktopPortForwardCreateInput = typeof DesktopPortForwardCreateInput.Type;

export const DesktopPortForwardSnapshot = Schema.Struct({
  id: DesktopPortForwardId,
  environmentId: EnvironmentId,
  localHost: TcpPortForwardHost,
  localPort: TcpPort,
  remoteHost: TcpPortForwardHost,
  remotePort: TcpPort,
  status: DesktopPortForwardStatus,
  connectingConnections: NonNegativeInt,
  activeConnections: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
});
export type DesktopPortForwardSnapshot = typeof DesktopPortForwardSnapshot.Type;

export const DesktopPortForwardStopInput = Schema.Struct({ id: DesktopPortForwardId });
export type DesktopPortForwardStopInput = typeof DesktopPortForwardStopInput.Type;

export const DesktopPortForwardStopEnvironmentInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type DesktopPortForwardStopEnvironmentInput =
  typeof DesktopPortForwardStopEnvironmentInput.Type;

export const DesktopPortForwardAuthorizationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  forwardId: DesktopPortForwardId,
  environmentId: EnvironmentId,
  remoteHost: TcpPortForwardHost,
  remotePort: TcpPort,
});
export type DesktopPortForwardAuthorizationRequest =
  typeof DesktopPortForwardAuthorizationRequest.Type;

export const DesktopPortForwardRoute = Schema.Literals(["primary", "direct", "relay", "ssh"]);
export type DesktopPortForwardRoute = typeof DesktopPortForwardRoute.Type;

export const DesktopPortForwardTransport = Schema.Union([
  Schema.TaggedStruct("WebSocketBridge", {
    protocol: Schema.Literal("per-connection-v1"),
    route: DesktopPortForwardRoute,
    socketUrl: Schema.String,
  }),
  Schema.TaggedStruct("SshSocks", {
    protocol: Schema.Literal("ssh-direct-tcpip-v1"),
    route: Schema.Literal("ssh"),
    socksPort: TcpPort,
    remoteHost: TcpPortForwardHost,
    remotePort: TcpPort,
  }),
]);
export type DesktopPortForwardTransport = typeof DesktopPortForwardTransport.Type;

export const DesktopPortForwardAuthorizationResolution = Schema.Union([
  Schema.TaggedStruct("Authorized", {
    requestId: TrimmedNonEmptyString,
    transport: DesktopPortForwardTransport,
  }),
  Schema.TaggedStruct("Rejected", {
    requestId: TrimmedNonEmptyString,
    route: Schema.NullOr(DesktopPortForwardRoute),
    error: TrimmedNonEmptyString,
  }),
]);
export type DesktopPortForwardAuthorizationResolution =
  typeof DesktopPortForwardAuthorizationResolution.Type;

/** Binary framing shared by the desktop listener and environment bridge. */
export const TCP_PORT_FORWARD_FRAME_DATA = 0;
export const TCP_PORT_FORWARD_FRAME_WRITE_END = 1;
export const TCP_PORT_FORWARD_FRAME_ACK = 2;
export const TCP_PORT_FORWARD_FRAME_ERROR = 3;
export const TCP_PORT_FORWARD_FRAME_CLOSE = 4;
export const TCP_PORT_FORWARD_INITIAL_CREDIT = 256 * 1024;
export const TCP_PORT_FORWARD_MAX_DATA_SIZE = 64 * 1024;

export interface DesktopPortForwardBridge {
  create: (input: DesktopPortForwardCreateInput) => Promise<DesktopPortForwardSnapshot>;
  list: () => Promise<ReadonlyArray<DesktopPortForwardSnapshot>>;
  stop: (id: DesktopPortForwardId) => Promise<void>;
  stopEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  resetEnvironmentConnections: (environmentId: EnvironmentId) => Promise<void>;
  resolveAuthorization: (resolution: DesktopPortForwardAuthorizationResolution) => Promise<void>;
  onStateChange: (
    listener: (forwards: ReadonlyArray<DesktopPortForwardSnapshot>) => void,
  ) => () => void;
  onAuthorizationRequest: (
    listener: (request: DesktopPortForwardAuthorizationRequest) => void,
  ) => () => void;
}
