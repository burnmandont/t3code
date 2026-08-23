# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Assistant delivery

Adapters for Codex, Claude, Cursor, Grok, and OpenCode normalize provider text into the same
`content.delta` event with `streamKind: assistant_text`. Delivery policy therefore lives once in
[`ProviderRuntimeIngestion`][ingest], after adapter normalization and before event persistence.

`streaming` is bounded, coalesced incremental delivery. It starts a 150 ms window with the first
pending delta (not a trailing-edge debounce) and flushes sooner at 1,024 buffered characters. A
message has at most one pending timer. Threshold flushes and the 24,000-character safety cap bound
memory even when a provider emits an unusually large burst. Approval requests, user-input requests,
tool transitions, assistant completion, turn completion or abort, runtime errors, and provider
session exit bypass the timer. These flushes enter the same serial ingestion worker as provider
events, preserving persisted ordering and exact concatenated text.

The existing `thread.message-sent` append contract is unchanged. Older clients and servers continue
to understand the stream, and reconnecting clients resume from their last event sequence. Each
thread WebSocket subscription buffers at most 256 live frames; overflow fails only that subscription
with the existing typed snapshot error. Current clients retry and replay from their last applied
sequence rather than accepting a silent gap. A client network disconnect does not flush global
provider state because other devices may still be watching; a provider `session.exited` event does.

There is no provider-specific delivery mode. Codex, Claude, and OpenCode can supply completion text
as a fallback when a provider emits no deltas. Cursor and Grok use ACP's normalized content deltas and
do not currently expose an equivalent full-text completion fallback, so their adapters depend on ACP
delivering every content delta. Once normalized, all five providers use identical coalescing,
persistence, replay, and boundary behavior.

Web and desktop share the structurally-shared web timeline. Mobile separately stabilizes feed rows;
on each chunk only the active assistant row receives a new object. The active Markdown document is
still parsed from its current complete text, but coalescing caps that work to the delivery cadence
instead of provider-token cadence.

`buffered` delivery remains available and accumulates assistant text instead of periodically
streaming it. It is not held without a bound: `MAX_BUFFERED_ASSISTANT_CHARS` is 24,000, and the append
that exceeds it spills the accumulated text as one delta. It also flushes at approval, user-input,
completion, abort, error, and provider-exit boundaries.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
