import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { RelayApi, RelayManagedEndpointRuntimeConfig } from "./relay.ts";

const decodeRuntimeConfig = Schema.decodeUnknownSync(RelayManagedEndpointRuntimeConfig);

describe("RelayManagedEndpointRuntimeConfig", () => {
  it("decodes provider-specific connector configuration", () => {
    expect(decodeRuntimeConfig({ providerKind: "manual" })).toEqual({
      providerKind: "manual",
    });
    expect(
      decodeRuntimeConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "cloudflare-token",
        tunnelId: "tunnel-id",
      }),
    ).toEqual({
      providerKind: "cloudflare_tunnel",
      connectorToken: "cloudflare-token",
      tunnelId: "tunnel-id",
    });
    expect(
      decodeRuntimeConfig({
        providerKind: "t3_relay",
        connectorId: "environment-id",
        connectorToken: "connector-token",
        serverAddr: "connect.example.test",
        serverPort: 7000,
        proxyName: "environment-proxy",
        hostname: "environment.example.test",
        localHttpHost: "127.0.0.1",
        localHttpPort: 3773,
      }),
    ).toEqual({
      providerKind: "t3_relay",
      connectorId: "environment-id",
      connectorToken: "connector-token",
      serverAddr: "connect.example.test",
      serverPort: 7000,
      proxyName: "environment-proxy",
      hostname: "environment.example.test",
      localHttpHost: "127.0.0.1",
      localHttpPort: 3773,
    });
  });

  it("normalizes excess fields and rejects incomplete provider configuration", () => {
    expect(
      decodeRuntimeConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "cloudflare-token",
        serverAddr: "unexpected.example.test",
      }),
    ).toEqual({
      providerKind: "cloudflare_tunnel",
      connectorToken: "cloudflare-token",
    });
    expect(() =>
      decodeRuntimeConfig({
        providerKind: "t3_relay",
        connectorToken: "connector-token",
      }),
    ).toThrow();
  });
});

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
