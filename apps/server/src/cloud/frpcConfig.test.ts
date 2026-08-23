import { describe, expect, it } from "@effect/vitest";

import type { RelayT3EndpointRuntimeConfig } from "@t3tools/contracts/relay";

import { renderFrpcConfig } from "./frpcConfig.ts";

const config: RelayT3EndpointRuntimeConfig = {
  providerKind: "t3_relay",
  connectorId: "connector-1",
  connectorToken: 'connector-1.secret"value',
  serverAddr: "gateway.example.test",
  serverPort: 443,
  proxyName: "environment-proxy",
  hostname: "environment.connect.example.test",
  localHttpHost: "127.0.0.1",
  localHttpPort: 3773,
};

describe("renderFrpcConfig", () => {
  it("renders one encrypted, hostname-bound loopback route", () => {
    const rendered = renderFrpcConfig(config);
    expect(rendered).toContain('serverAddr = "gateway.example.test"');
    expect(rendered).toContain("serverPort = 443");
    expect(rendered).toContain('transport.protocol = "wss"');
    expect(rendered).toContain("transport.tls.enable = true");
    expect(rendered).toContain('user = "connector-1"');
    expect(rendered).toContain('metadatas.t3_connector_token = "connector-1.secret\\\"value"');
    expect(rendered).toContain('name = "environment-proxy"');
    expect(rendered).toContain('type = "http"');
    expect(rendered).toContain('localIP = "127.0.0.1"');
    expect(rendered).toContain("localPort = 3773");
    expect(rendered).toContain('customDomains = ["environment.connect.example.test"]');
    expect(rendered).toContain('requestHeaders.set.x-forwarded-proto = "https"');
    expect(rendered).toContain("transport.useEncryption = true");
    expect(rendered.match(/\[\[proxies\]\]/gu)).toHaveLength(1);
  });
});
