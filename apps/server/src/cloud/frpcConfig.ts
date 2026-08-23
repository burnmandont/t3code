import type { RelayT3EndpointRuntimeConfig } from "@t3tools/contracts/relay";

export const FRP_CONNECTOR_TOKEN_METADATA_KEY = "t3_connector_token";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Renders the sole frpc route authorized by the sovereign relay. The connector
 * token is written only to this owner-readable file and never to argv.
 */
export function renderFrpcConfig(config: RelayT3EndpointRuntimeConfig): string {
  return [
    `serverAddr = ${tomlString(config.serverAddr)}`,
    `serverPort = ${config.serverPort}`,
    `user = ${tomlString(config.connectorId)}`,
    "loginFailExit = false",
    'transport.protocol = "wss"',
    "transport.tls.enable = true",
    "transport.heartbeatInterval = 10",
    `metadatas.${FRP_CONNECTOR_TOKEN_METADATA_KEY} = ${tomlString(config.connectorToken)}`,
    "",
    "[[proxies]]",
    `name = ${tomlString(config.proxyName)}`,
    'type = "http"',
    `localIP = ${tomlString(config.localHttpHost)}`,
    `localPort = ${config.localHttpPort}`,
    `customDomains = [${tomlString(config.hostname)}]`,
    'requestHeaders.set.x-forwarded-proto = "https"',
    "transport.useEncryption = true",
    "",
  ].join("\n");
}
