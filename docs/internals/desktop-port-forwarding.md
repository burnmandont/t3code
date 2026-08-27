# Desktop Port Forwarding

> The bridge-first manual forwarding slice is implemented. Persistence and
> preview discovery actions remain follow-up work.

## Decision

T3 Code provides environment-scoped local TCP forwarding in the desktop app.

The initial feature maps a loopback listener on the desktop to a loopback TCP
service on one selected remote environment:

```text
development  127.0.0.1:3000 -> desktop 127.0.0.1:43001
primary      127.0.0.1:3000 -> desktop 127.0.0.1:43002
development  127.0.0.1:5432 -> desktop 127.0.0.1:45432
```

It is a private client-side tunnel, not a mechanism for publishing remote
services on the Internet.

## Transport

Carry forwarding traffic through the environment's selected authenticated
HTTPS/WSS endpoint. A forward does not allocate another public endpoint or
broaden the environment's network exposure:

```text
desktop loopback listener
  -> Electron PortForwardManager
  -> selected forwarding transport adapter
     -> SSH SOCKS/direct-tcpip -> remote loopback service
     -> authenticated WebSocket -> remote T3 TCP bridge
        -> remote loopback service
```

The ticket contract represents the remote loopback boundary as `127.0.0.1`,
not as permission to dial an arbitrary host. At the final bridge boundary, the
server tries both `127.0.0.1` and `::1` so a service using the platform's
`localhost` default works whether it selected IPv4 or IPv6.

The authorization boundary returns a prepared transport descriptor rather
than an untyped socket URL. The descriptor identifies the selected route as
`primary`, `direct`, `relay`, or `ssh`, and identifies the wire protocol. The
Electron manager owns listener and connection lifecycle; a transport adapter
owns connection setup, I/O, and close behavior. Keep this boundary intact when
upstream changes touch authorization IPC or the manager.

Two adapters are implemented:

- `ssh-direct-tcpip-v1` connects through a private SOCKS5 listener supplied by
  the existing desktop-owned OpenSSH process. Node streams provide native
  backpressure and half-close behavior; payload bytes do not enter the T3
  server.
- `per-connection-v1` uses one dedicated authenticated WebSocket per accepted
  TCP connection. It remains the compatibility path for primary, direct, and
  relay routes, and for an SSH preparation that does not advertise its SOCKS
  listener.

The WebSocket adapter keeps framing, cancellation, and backpressure separate
from the ordinary T3 control connection. It is not the intended final
transport for every route.

Relay connections refresh their DPoP credential before it expires. If a ticket
request is nevertheless rejected, concurrent forward attempts share one
environment reconnect and retry ticket authorization once with the refreshed
prepared connection.

Each accepted desktop TCP connection requests its ticket from the current
`PreparedConnection`, so new bridges follow the selected relay, direct, or SSH
route. `EnvironmentRegistry.selectRoute` invokes the platform route-transition
hook only after the candidate has been prepared and installed. Desktop uses
that hook to advance every affected forward's generation, close its active and
connecting socket/WebSocket pairs, and retain its loopback listener. Stale
authorization completions cannot reopen a bridge from the previous generation.
TCP streams are not transparently migratable; the local application must
reconnect, at which point authorization uses the newly selected route.

The server must advertise an additive `tcpPortForwarding` environment
capability. The implementation is independent of the selected route:

- T3 Connect environments use the authenticated WebSocket bridge through the
  relay route.
- SSH environments use OpenSSH `direct-tcpip` channels through the existing
  desktop-managed SSH process. The process retains its `-L` listener for T3
  HTTP/RPC and adds a private loopback `-D` listener for forwarded TCP streams.
- Local environments do not need a tunnel.

A future direct/relay adapter may multiplex independent streams on one
dedicated forwarding WebSocket. It must not put forwarding payloads on the
ordinary RPC connection, and a slow stream must not consume another stream's
flow-control credit. The adapter is selected only from the prepared connection
route; never infer it from a hostname or URL.

## Telemetry and performance gates

Desktop connection spans are the route-aware source of truth because native
SSH forwarding bypasses the server bridge entirely. Each
`desktop.portForward.connection` span records only bounded route, transport,
outcome, failure-operation, and close-reason values, plus authorization,
transport-connect, first-byte and total duration and directional byte counts.
Do not attach environment IDs, forward IDs, ports, endpoint URLs, tickets, or
payload content.

Server-side bridge telemetry can describe the WebSocket bridge but cannot
reliably infer whether the desktop reached it through direct, relay, or SSH.
Do not manufacture a server route label from request addresses. Route-aware
aggregation belongs at the desktop adapter boundary.

Performance changes follow a before/after gate using the same harness and an
isolated server. Measure at least single-connection open-and-echo latency,
16-connection fan-out, and sustained 16 MiB throughput. Compare multiple
interleaved runs against the untouched source boundary. Machine-specific
numbers belong in the owning issue or PR; the durable invariant is that
telemetry stays off the per-byte export/logging path and does not cause a
material regression.

## Multi-environment ownership

Electron main owns one process-wide `PortForwardManager`. A forward has a
stable `forwardId` and is scoped internally by `environmentId`, remote host,
and remote port. Display labels are never identity: duplicate environment
labels must remain harmless.

The manager currently owns:

- loopback listeners and atomic port allocation;
- active socket/WebSocket pairs;
- runtime-only definitions;
- account-switch and remote-revocation teardown;
- per-forward and global connection limits.

Persistence, auto-start, waiting/reconnecting states, and creation
deduplication remain part of the next lifecycle-focused slice.

A persisted definition should contain at least:

```ts
interface SavedPortForward {
  readonly forwardId: string;
  readonly environmentId: string;
  readonly remoteHost: "127.0.0.1" | "::1" | "localhost";
  readonly remotePort: number;
  readonly preferredLocalPort: number | null;
  readonly autoStart: boolean;
  readonly label: string | null;
}
```

The assigned local port is device-local runtime state. It should not be synced
through the relay. Bind the real listener atomically; never probe a free port,
release it, and bind later. If a requested port is occupied, report a conflict
or visibly allocate another port—never silently replace an existing mapping.

When an environment is unavailable, retain its saved definition in a waiting
state. Reconcile it when that exact environment ID returns. Removing or
revoking an environment and switching accounts must immediately close its
listeners and all active connections.

## User experience

The desktop Connections settings include a Port forwarding panel with one row
per running definition. The current panel shows:

- environment label plus a short environment-ID fingerprint;
- remote destination and assigned desktop address;
- listener, connecting, connected, and error status;
- connecting and established bridge counts kept separate;
- manual creation and stop actions.

Copy address, open HTTP service, edit, persistence, and richer lifecycle states
remain follow-ups.

The remote server already discovers common loopback development ports. Add a
one-click **Forward to this Mac** action to those results while retaining a
manual TCP-port form. Prefer the same local and remote port when available;
allocate a clear alternate when several environments expose the same port.

HTTP-aware host-header rewriting, friendly `*.localhost` names, and reverse
forwarding are separate follow-ups. The initial primitive remains transparent
TCP, so applications that require a specific HTTP Host or TLS hostname may
need an explicit later HTTP mode.

## Security boundary

The first release must be deliberately narrow:

- TCP only; no UDP.
- Desktop only; web and mobile cannot create operating-system listeners.
- Bind only desktop loopback, never `0.0.0.0` or a LAN address.
- Dial only remote loopback, never arbitrary LAN, container-network, or public
  destinations.
- Authorize each WebSocket-bridge connection with a short-lived, single-use,
  environment-scoped ticket bound to destination and expiration. Native SSH
  streams inherit the already-authenticated OpenSSH process and remain limited
  by the typed contract to remote loopback.
- Enforce port validation, bounded buffers, flow control, connection limits,
  idle timeouts, and deterministic half-close/cancellation behavior.
- Log metadata and lifecycle only; never log forwarded bytes or credentials.
- Terminate immediately on sign-out, account switch, environment removal,
  remote revocation, or authorization expiry.

Arbitrary remote destinations would turn an environment into a network pivot.
LAN-visible desktop listeners would expose remote services to the desktop's
network. Both require separate explicit designs and must not arrive as hidden
options in the initial dialog.

## Existing foundations

- `packages/ssh/src/tunnel.ts` already demonstrates loopback allocation,
  tunnel supervision, pending-entry deduplication, readiness, and cleanup.
- The server preview port scanner already finds remote development listeners.
- Contracts and RPC already support streaming operations and byte arrays.
- Environment IDs provide stable multi-remote scoping.
- T3 Connect supplies the authenticated TLS/WSS path.
- Electron already owns IPC validation and local saved-environment state.

The implemented slice includes the authenticated TCP bridge, binary connection
protocol, Electron manager, manual UI, bounded flow control, environment-removal
cleanup, idle timeouts, and connection limits. Persistence and deeper lifecycle
reconciliation remain.

## Delivery order and estimate

1. **Complete:** Contracts, capability, ticket scope, and remote loopback TCP bridge.
2. **Complete:** Dedicated binary WebSocket with bounded flow control and close semantics.
3. **Partial:** Electron manager with atomic listeners and environment-removal cleanup.
4. **Partial:** Runtime-only definitions and manual desktop UI; persistence remains.
5. **Complete:** SSH routes use the same authenticated environment bridge.
6. Failure-recovery, account-switch, revocation, load, and adversarial tests.

A proof of concept is several focused days. A production-quality TCP feature
with persistence, reconnect behavior, conflict handling, limits, UI, and
security verification is approximately two to four focused engineering weeks.
