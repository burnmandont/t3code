import { resolveTcpPortForwardSocketUrl } from "@t3tools/client-runtime/authorization";
import type { ConnectionTargetKind } from "@t3tools/client-runtime/connection";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { DesktopPortForwardRoute, DesktopPortForwardTransport } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { useEffect } from "react";

import { runtime } from "../../lib/runtime";
import {
  readCurrentPreparedConnection,
  refreshCurrentPreparedConnection,
} from "../../state/session";
import {
  isMissingPortForwardEnvironment,
  isRejectedPortForwardAuthorization,
  portForwardAuthorizationErrorMessage,
} from "./desktopPortForwardAuthorization";

export function desktopPortForwardRoute(target: ConnectionTargetKind): DesktopPortForwardRoute {
  switch (target) {
    case "PrimaryConnectionTarget":
      return "primary";
    case "BearerConnectionTarget":
      return "direct";
    case "RelayConnectionTarget":
      return "relay";
    case "SshConnectionTarget":
      return "ssh";
  }
}

export function nativeSshPortForwardTransport(
  prepared: PreparedConnection,
  remoteHost: "127.0.0.1",
  remotePort: number,
): DesktopPortForwardTransport | null {
  if (
    prepared.target._tag !== "SshConnectionTarget" ||
    prepared.sshForwardingSocksPort === undefined
  ) {
    return null;
  }
  return {
    _tag: "SshSocks",
    protocol: "ssh-direct-tcpip-v1",
    route: "ssh",
    socksPort: prepared.sshForwardingSocksPort,
    remoteHost,
    remotePort,
  };
}

export function DesktopPortForwardAuthorizationBridge() {
  useEffect(() => {
    const bridge = window.desktopBridge?.portForward;
    if (bridge === undefined) return;

    return bridge.onAuthorizationRequest((request) => {
      const authorize = (
        prepared: NonNullable<Awaited<ReturnType<typeof readCurrentPreparedConnection>>>,
      ) =>
        runtime.runPromiseExit(
          Effect.gen(function* () {
            const nativeSsh = nativeSshPortForwardTransport(
              prepared,
              request.remoteHost,
              request.remotePort,
            );
            if (nativeSsh !== null) return nativeSsh;
            const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
            const socketUrl = yield* resolveTcpPortForwardSocketUrl({
              prepared,
              signer,
              remoteHost: request.remoteHost,
              remotePort: request.remotePort,
            });
            return {
              _tag: "WebSocketBridge",
              protocol: "per-connection-v1",
              route: desktopPortForwardRoute(prepared.target._tag),
              socketUrl,
            } satisfies DesktopPortForwardTransport;
          }),
        );

      void readCurrentPreparedConnection(request.environmentId)
        .then(async (prepared) => {
          if (prepared === null) {
            // Authorization requests are broadcast to every desktop window.
            // Only the renderer that owns a live connection should answer.
            return;
          }
          const first = await authorize(prepared);
          if (Exit.isSuccess(first)) return { prepared, result: first };
          const failure = first.cause.reasons.find(Cause.isFailReason)?.error;
          if (!isRejectedPortForwardAuthorization(failure)) return { prepared, result: first };

          const refreshed = await refreshCurrentPreparedConnection(request.environmentId);
          return refreshed === null
            ? { prepared, result: first }
            : { prepared: refreshed, result: await authorize(refreshed) };
        })
        .then((authorized) => {
          if (authorized === undefined) return;
          if (Exit.isSuccess(authorized.result)) {
            return bridge.resolveAuthorization({
              _tag: "Authorized",
              requestId: request.requestId,
              transport: authorized.result.value,
            });
          }
          return bridge.resolveAuthorization({
            _tag: "Rejected",
            requestId: request.requestId,
            route: desktopPortForwardRoute(authorized.prepared.target._tag),
            error: portForwardAuthorizationErrorMessage(Cause.squash(authorized.result.cause)),
          });
        })
        .catch((cause) => {
          // Authorization requests used to be broadcast to every desktop
          // renderer. Old windows that do not own this environment must stay
          // silent so they cannot race the connected renderer's response.
          if (isMissingPortForwardEnvironment(cause)) return;
          return bridge
            .resolveAuthorization({
              _tag: "Rejected",
              requestId: request.requestId,
              route: null,
              error: portForwardAuthorizationErrorMessage(cause),
            })
            .catch(() => undefined);
        });
    });
  }, []);

  return null;
}
