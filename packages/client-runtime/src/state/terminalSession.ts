import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
  readonly renderVersion: number;
  readonly renderUpdates: ReadonlyArray<TerminalRenderUpdate>;
}

export interface TerminalRenderUpdate {
  readonly version: number;
  readonly type: "append" | "reset";
  readonly data: string;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
  readonly renderVersion: number;
  readonly renderUpdates: ReadonlyArray<TerminalRenderUpdate>;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
  renderVersion: 0,
  renderUpdates: [],
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
  renderVersion: 0,
  renderUpdates: [],
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
export const DEFAULT_MAX_TERMINAL_RENDER_UPDATES = 64;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  const buffer = trimBufferToBytes(snapshot.history, maxBufferBytes);
  return {
    buffer,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
    renderVersion: 1,
    renderUpdates: [{ version: 1, type: "reset", data: buffer }],
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
    renderVersion: buffer.renderVersion,
    renderUpdates: buffer.renderUpdates,
  };
}

function appendTerminalRenderUpdate(
  current: TerminalBufferState,
  type: TerminalRenderUpdate["type"],
  data: string,
): Pick<TerminalBufferState, "renderVersion" | "renderUpdates"> {
  const update = { version: current.renderVersion + 1, type, data } as const;
  const renderUpdates =
    type === "reset"
      ? [update]
      : [...current.renderUpdates, update].slice(-DEFAULT_MAX_TERMINAL_RENDER_UPDATES);
  return { renderVersion: update.version, renderUpdates };
}

export type TerminalRenderAction =
  | { readonly type: "none"; readonly version: number }
  | { readonly type: "append" | "reset"; readonly version: number; readonly data: string };

/** Returns every render delta since the surface's cursor, or a full reset after a gap. */
export function resolveTerminalRenderAction(
  state: Pick<TerminalBufferState, "buffer" | "renderVersion" | "renderUpdates">,
  renderedVersion: number,
): TerminalRenderAction {
  if (renderedVersion === state.renderVersion) {
    return { type: "none", version: renderedVersion };
  }

  const firstUpdateIndex = state.renderUpdates.findIndex(
    (update) => update.version === renderedVersion + 1,
  );
  if (firstUpdateIndex < 0) {
    return { type: "reset", version: state.renderVersion, data: state.buffer };
  }

  const updates = state.renderUpdates.slice(firstUpdateIndex);
  for (let index = 1; index < updates.length; index += 1) {
    if (updates[index]!.version !== updates[index - 1]!.version + 1) {
      return { type: "reset", version: state.renderVersion, data: state.buffer };
    }
  }
  const lastReset = updates.findLastIndex((update) => update.type === "reset");
  const applicable = lastReset < 0 ? updates : updates.slice(lastReset);
  return {
    type: lastReset < 0 ? "append" : "reset",
    version: state.renderVersion,
    data: applicable.map((update) => update.data).join(""),
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted": {
      const snapshot = terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
      return {
        ...snapshot,
        version: current.version + 1,
        ...appendTerminalRenderUpdate(current, "reset", snapshot.buffer),
      };
    }
    case "output":
      return {
        ...current,
        buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
        ...appendTerminalRenderUpdate(current, "append", event.data),
      };
    case "cleared":
      return {
        ...current,
        buffer: "",
        error: null,
        version: current.version + 1,
        ...appendTerminalRenderUpdate(current, "reset", ""),
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
