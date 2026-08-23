import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CLIENT_SERVER_PROTOCOL_VERSION, ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("decodes descriptors from servers that predate protocol identity", () => {
    expect(decodeDescriptor(descriptor).clientServerProtocolVersion).toBeUndefined();
  });

  it("decodes the current client/server protocol identity", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        clientServerProtocolVersion: CLIENT_SERVER_PROTOCOL_VERSION,
      }).clientServerProtocolVersion,
    ).toBe(CLIENT_SERVER_PROTOCOL_VERSION);
  });

  it("rejects invalid protocol identities", () => {
    expect(() => decodeDescriptor({ ...descriptor, clientServerProtocolVersion: 0 })).toThrow();
  });
});
