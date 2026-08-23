import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";

import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";

export const FRP_CONNECTOR_TOKEN_METADATA_KEY = "t3_connector_token";

export interface FrpPluginResponse {
  readonly reject: boolean;
  readonly unchange?: boolean;
  readonly reject_reason?: string;
}

type FrpAuthorizationError = ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecordValue(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function metadataToken(value: unknown): string | null {
  return stringRecordValue(value, FRP_CONNECTOR_TOKEN_METADATA_KEY);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const comparedLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < comparedLength; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

const rejected = (reason = "connector not authorized"): FrpPluginResponse => ({
  reject: true,
  reject_reason: reason,
});

const allowed: FrpPluginResponse = { reject: false, unchange: true };

function connectorIdentity(input: Record<string, unknown>): {
  readonly connectorId: string;
  readonly connectorToken: string;
} | null {
  const operation = stringRecordValue(input, "op");
  const content = isRecord(input.content) ? input.content : null;
  if (operation === null || content === null) return null;

  if (operation === "Login") {
    const connectorId = stringRecordValue(content, "user");
    const connectorToken = metadataToken(content.metas);
    return connectorId === null || connectorToken === null ? null : { connectorId, connectorToken };
  }

  const user = isRecord(content.user) ? content.user : null;
  const connectorId = user === null ? null : stringRecordValue(user, "user");
  const connectorToken = user === null ? null : metadataToken(user.metas);
  return connectorId === null || connectorToken === null ? null : { connectorId, connectorToken };
}

function routeIsAuthorized(input: {
  readonly request: Record<string, unknown>;
  readonly connectorId: string;
  readonly allocation: ManagedEndpointAllocations.ManagedEndpointAllocation;
}): boolean {
  const operation = stringRecordValue(input.request, "op");
  const content = isRecord(input.request.content) ? input.request.content : null;
  if (content === null) return false;
  const canonicalProxyName = `${input.connectorId}.${input.allocation.tunnelName}`;

  switch (operation) {
    case "Login":
    case "Ping":
      return true;
    case "NewProxy": {
      const customDomains = content.custom_domains;
      const locations = content.locations;
      return (
        stringRecordValue(content, "proxy_name") === canonicalProxyName &&
        stringRecordValue(content, "proxy_type") === "http" &&
        content.use_encryption === true &&
        Array.isArray(customDomains) &&
        customDomains.length === 1 &&
        customDomains[0] === input.allocation.hostname &&
        (content.subdomain === undefined || content.subdomain === "") &&
        (locations === undefined || (Array.isArray(locations) && locations.length === 0))
      );
    }
    case "CloseProxy":
      return stringRecordValue(content, "proxy_name") === canonicalProxyName;
    default:
      return false;
  }
}

export class FrpAuthorization extends Context.Service<
  FrpAuthorization,
  {
    readonly authorize: (
      request: unknown,
    ) => Effect.Effect<FrpPluginResponse, FrpAuthorizationError>;
  }
>()("t3code-relay/frp/FrpAuthorization") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;

  return FrpAuthorization.of({
    authorize: Effect.fn("relay.frp.authorize")(function* (request: unknown) {
      if (!isRecord(request)) return rejected();
      const identity = connectorIdentity(request);
      if (identity === null || !identity.connectorToken.startsWith(`${identity.connectorId}.`)) {
        return rejected();
      }
      const allocation = yield* allocations.getByConnectorId(identity.connectorId);
      if (
        allocation === null ||
        allocation.providerKind !== "t3_relay" ||
        allocation.tunnelId !== identity.connectorId ||
        allocation.connectorTokenHash === null ||
        allocation.readyAt === null
      ) {
        return rejected();
      }
      const presentedHash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(identity.connectorToken))
        .pipe(Effect.map(Encoding.encodeHex), Effect.orDie);
      if (!constantTimeEqual(presentedHash, allocation.connectorTokenHash)) {
        return rejected();
      }
      return routeIsAuthorized({ request, connectorId: identity.connectorId, allocation })
        ? allowed
        : rejected("connector route not authorized");
    }),
  });
});

export const layer = Layer.effect(FrpAuthorization, make);
