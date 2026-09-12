import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  connectionRoutes,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeConnectionRouteFromCatalog,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const REMOTE_TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});

describe("ConnectionCatalogDocument", () => {
  it("treats targets from a legacy catalog as its initial routes", () => {
    const decoded = Schema.decodeUnknownSync(ConnectionCatalogDocument)({
      schemaVersion: 1,
      targets: [BEARER_TARGET],
      profiles: [BEARER_PROFILE],
      credentials: [],
      remoteDpopTokens: [],
    });

    expect(decoded.routes).toEqual([]);
    expect(connectionRoutes(decoded)).toEqual([BEARER_TARGET]);
  });

  it.each([
    { name: "legacy", accountId: undefined },
    { name: "account-bound", accountId: "account-1" },
  ])("round-trips a catalog containing a $name DPoP token", ({ accountId }) => {
    const token = new TokenStore.RemoteDpopAccessToken({
      ...REMOTE_TOKEN,
      ...(accountId === undefined ? {} : { accountId }),
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [RELAY_TARGET],
      remoteDpopTokens: [token],
    };
    const schema = Schema.fromJsonString(ConnectionCatalogDocument);
    const restored = Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(document));

    expect(restored).toEqual(document);
    expect(restored.remoteDpopTokens[0]?.accountId).toBe(accountId);
  });

  it("registers a bearer connection as one catalog mutation", () => {
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(document.targets).toEqual([BEARER_TARGET]);
    expect(document.routes).toEqual([BEARER_TARGET]);
    expect(document.profiles).toEqual([BEARER_PROFILE]);
    expect(document.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
  });

  it("selects a newly registered route without discarding other routes", () => {
    const bearer = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const relayTarget = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
    });
    const relay = registerConnectionInCatalog(
      bearer,
      new RelayConnectionRegistration({ target: relayTarget }),
    );

    expect(relay.targets).toEqual([relayTarget]);
    expect(relay.routes).toEqual([BEARER_TARGET, relayTarget]);
    expect(relay.profiles).toEqual([BEARER_PROFILE]);
    expect(relay.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
    expect(relay.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, BEARER_TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("removes a relay route without discarding another route for the environment", () => {
    const relayTarget = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
    });
    const registered = registerConnectionInCatalog(
      registerConnectionInCatalog(
        {
          ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
          remoteDpopTokens: [REMOTE_TOKEN],
        },
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ),
      new RelayConnectionRegistration({ target: relayTarget }),
    );

    expect(removeConnectionRouteFromCatalog(registered, relayTarget, BEARER_TARGET)).toEqual({
      ...registered,
      targets: [BEARER_TARGET],
      routes: [BEARER_TARGET],
      remoteDpopTokens: [],
    });
  });

  it("stores a DPoP token for a registered relay environment", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );

    expect(putRemoteDpopTokenInCatalog(registered, REMOTE_TOKEN)).toEqual({
      ...registered,
      remoteDpopTokens: [REMOTE_TOKEN],
    });
  });

  it("ignores a late DPoP token after the environment is removed", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );
    const removed = removeConnectionFromCatalog(registered, RELAY_TARGET);

    expect(putRemoteDpopTokenInCatalog(removed, REMOTE_TOKEN)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("removes a DPoP token stored before the environment is removed", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );
    const refreshed = putRemoteDpopTokenInCatalog(registered, REMOTE_TOKEN);

    expect(removeConnectionFromCatalog(refreshed, RELAY_TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("does not store DPoP tokens for a different environment or connection kind", () => {
    const bearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const otherRelay = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: EnvironmentId.make("environment-2"),
          label: "Other relay",
        }),
      }),
    );

    expect(putRemoteDpopTokenInCatalog(bearer, REMOTE_TOKEN)).toBe(bearer);
    expect(putRemoteDpopTokenInCatalog(otherRelay, REMOTE_TOKEN)).toBe(otherRelay);
  });

  it("persists the normalized SSH profile beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.routes).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([]);
  });

  it("persists an SSH bearer credential when provisioning supplies one", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const credential = new BearerConnectionCredential({ token: "ssh-bearer" });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential }),
    );

    expect(document.credentials).toEqual([{ connectionId: target.connectionId, credential }]);
  });

  it("preserves an SSH bearer credential when re-registration supplies no replacement", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const credential = new BearerConnectionCredential({ token: "ssh-bearer" });
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential }),
    );

    const reRegistered = registerConnectionInCatalog(
      registered,
      new SshConnectionRegistration({ target, profile }),
    );

    expect(reRegistered.credentials).toEqual([{ connectionId: target.connectionId, credential }]);
  });
});
