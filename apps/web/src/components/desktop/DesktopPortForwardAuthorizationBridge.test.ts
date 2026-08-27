import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { SshConnectionTarget } from "@t3tools/client-runtime/connection";

import {
  desktopPortForwardRoute,
  nativeSshPortForwardTransport,
} from "./DesktopPortForwardAuthorizationBridge";

describe("desktopPortForwardRoute", () => {
  it.each([
    ["PrimaryConnectionTarget", "primary"],
    ["BearerConnectionTarget", "direct"],
    ["RelayConnectionTarget", "relay"],
    ["SshConnectionTarget", "ssh"],
  ] as const)("maps %s to %s", (target, route) => {
    expect(desktopPortForwardRoute(target)).toBe(route);
  });
});

it("selects native SSH forwarding only when the prepared tunnel exposes SOCKS", () => {
  const target = new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "SSH",
    connectionId: "ssh-1",
  });
  const prepared = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: "http://127.0.0.1:41000",
    socketUrl: "ws://127.0.0.1:41000/ws",
    httpAuthorization: null,
    target,
    sshForwardingSocksPort: 41_001,
  } as const;

  expect(nativeSshPortForwardTransport(prepared, "127.0.0.1", 3000)).toEqual({
    _tag: "SshSocks",
    protocol: "ssh-direct-tcpip-v1",
    route: "ssh",
    socksPort: 41_001,
    remoteHost: "127.0.0.1",
    remotePort: 3000,
  });
  const { sshForwardingSocksPort: _, ...legacyPrepared } = prepared;
  expect(nativeSshPortForwardTransport(legacyPrepared, "127.0.0.1", 3000)).toBeNull();
});
