import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import { FRP_CONNECTOR_TOKEN_METADATA_KEY, FrpAuthorization, layer } from "./FrpAuthorization.ts";

const connectorId = "connector-1";
const connectorToken = `${connectorId}.a-long-random-secret`;
const connectorTokenHash = NodeCrypto.createHash("sha256").update(connectorToken).digest("hex");

const allocation: ManagedEndpointAllocations.ManagedEndpointAllocation = {
  userId: "user-1",
  environmentId: "environment-1",
  providerKind: "t3_relay",
  hostname: "environment.connect.example.test",
  tunnelId: connectorId,
  tunnelName: "environment-proxy",
  dnsRecordId: null,
  connectorTokenHash,
  readyAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

function testLayer(current: ManagedEndpointAllocations.ManagedEndpointAllocation | null) {
  const unused = () => Effect.die("unused");
  const allocations = ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    get: unused,
    getByConnectorId: (requestedConnectorId) =>
      Effect.succeed(current?.tunnelId === requestedConnectorId ? current : null),
    listOrphaned: () => Effect.succeed([]),
    reserve: unused,
    recordTunnel: unused,
    recordDns: unused,
    recordConnectorCredential: unused,
    markReady: unused,
    claimRelease: unused,
    claimConnectorRevocation: unused,
    claimDeprovision: unused,
    remove: unused,
    removeClaimed: unused,
  });
  return layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, allocations),
    ),
  );
}

const user = {
  user: connectorId,
  metas: { [FRP_CONNECTOR_TOKEN_METADATA_KEY]: connectorToken },
  run_id: "run-1",
};

describe("FrpAuthorization", () => {
  it.effect("authorizes login and heartbeat only for the active credential", () =>
    Effect.gen(function* () {
      const authorization = yield* FrpAuthorization;
      expect(
        yield* authorization.authorize({
          version: "0.1.0",
          op: "Login",
          content: {
            user: connectorId,
            metas: { [FRP_CONNECTOR_TOKEN_METADATA_KEY]: connectorToken },
          },
        }),
      ).toEqual({ reject: false, unchange: true });
      expect(
        yield* authorization.authorize({
          version: "0.1.0",
          op: "Ping",
          content: { user },
        }),
      ).toEqual({ reject: false, unchange: true });
      expect(
        yield* authorization.authorize({
          version: "0.1.0",
          op: "Login",
          content: {
            user: connectorId,
            metas: { [FRP_CONNECTOR_TOKEN_METADATA_KEY]: `${connectorId}.wrong` },
          },
        }),
      ).toMatchObject({ reject: true });
    }).pipe(Effect.provide(testLayer(allocation))),
  );

  it.effect("allows only the allocated encrypted HTTP route", () =>
    Effect.gen(function* () {
      const authorization = yield* FrpAuthorization;
      const request = {
        version: "0.1.0",
        op: "NewProxy",
        content: {
          user,
          proxy_name: `${connectorId}.${allocation.tunnelName}`,
          proxy_type: "http",
          use_encryption: true,
          custom_domains: [allocation.hostname],
          subdomain: "",
          locations: [],
        },
      };
      expect(yield* authorization.authorize(request)).toEqual({
        reject: false,
        unchange: true,
      });
      expect(
        yield* authorization.authorize({
          ...request,
          content: {
            user: request.content.user,
            proxy_name: request.content.proxy_name,
            proxy_type: request.content.proxy_type,
            use_encryption: request.content.use_encryption,
            custom_domains: request.content.custom_domains,
          },
        }),
      ).toEqual({ reject: false, unchange: true });
      expect(
        yield* authorization.authorize({
          ...request,
          content: { ...request.content, custom_domains: ["victim.example.test"] },
        }),
      ).toMatchObject({ reject: true });
      expect(
        yield* authorization.authorize({
          ...request,
          content: { ...request.content, proxy_type: "tcp" },
        }),
      ).toMatchObject({ reject: true });
      expect(
        yield* authorization.authorize({
          ...request,
          content: { ...request.content, use_encryption: false },
        }),
      ).toMatchObject({ reject: true });
    }).pipe(Effect.provide(testLayer(allocation))),
  );

  it.effect("rejects a previously valid heartbeat after revocation", () =>
    Effect.gen(function* () {
      const authorization = yield* FrpAuthorization;
      expect(yield* authorization.authorize({ op: "Ping", content: { user } })).toMatchObject({
        reject: true,
      });
    }).pipe(
      Effect.provide(
        testLayer({
          ...allocation,
          connectorTokenHash: null,
        }),
      ),
    ),
  );

  it.effect("rejects unsupported plugin operations", () =>
    Effect.gen(function* () {
      const authorization = yield* FrpAuthorization;
      expect(
        yield* authorization.authorize({
          op: "NewWorkConn",
          content: { user },
        }),
      ).toMatchObject({ reject: true });
    }).pipe(Effect.provide(testLayer(allocation))),
  );
});
