import * as NodeCrypto from "node:crypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@t3tools/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayDb from "../RelayDbService.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinker from "./EnvironmentLinker.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProviderService.ts";

const relayKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(relayKeyPair.privateKey),
  cloudMintPublicKey: relayKeyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const isEnvironmentLinkProofInvalid = Schema.is(EnvironmentLinker.EnvironmentLinkProofInvalid);
const isEnvironmentLinkRetired = Schema.is(EnvironmentLinks.EnvironmentLinkRetired);

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const makeRequestFor = (managedTunnelsEnabled: boolean, transferExistingLinks = false) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const relayTokens = yield* RelayTokens.RelayTokens;
    const challenge = yield* relayTokens.issueLinkChallenge({
      userId: "user_123",
      request: {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
        transferExistingLinks,
      },
      jti: "challenge-jti",
      issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
    });
    const payload = {
      iss: "t3-env:env-link-test",
      aud: "https://relay.example.test",
      sub: "env-link-test",
      jti: "link-proof-jti",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      challenge,
      environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
      descriptor: {
        environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
        label: "Link Test Environment",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      environmentPublicKey: environmentKeyPair.publicKey.trim(),
      endpoint: {
        httpBaseUrl: "https://env.example.test/",
        wsBaseUrl: "wss://env.example.test/",
        providerKind: "manual",
      },
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      scopes: ["agent_activity_notifications", "managed_tunnels"],
    } satisfies RelayEnvironmentLinkProofPayload;
    return {
      request: {
        proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
        transferExistingLinks,
      } satisfies RelayEnvironmentLinkRequest,
      payload,
    };
  });

const makeRequest = makeRequestFor(false);

function testLayer(input?: {
  readonly upsert?: EnvironmentLinks.EnvironmentLinks["Service"]["upsert"];
  readonly ensureRelinkAllowed?: EnvironmentLinks.EnvironmentLinks["Service"]["ensureRelinkAllowed"];
  readonly consume?: DpopProofs.DpopProofReplay["Service"]["consume"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
  readonly provision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["provision"];
  readonly revokeOtherUsersForEnvironmentKey?: EnvironmentLinks.EnvironmentLinks["Service"]["revokeOtherUsersForEnvironmentKey"];
}) {
  return EnvironmentLinker.layer.pipe(
    Layer.provideMerge(RelayTokens.layer),
    Layer.provide(
      Layer.mergeAll(
        RelayConfiguration.layer(config),
        Layer.succeed(
          RelayDb.RelayTransactions,
          RelayDb.RelayTransactions.of({ withTransaction: (effect) => effect }),
        ),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume: () => Effect.die("unexpected DPoP proof verification"),
          consume: input?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: Effect.void,
        }),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
          upsert: input?.upsert ?? (() => Effect.void),
          ensureRelinkAllowed: input?.ensureRelinkAllowed ?? (() => Effect.void),
          listUsersForEnvironment: () => Effect.succeed([]),
          listDeliveryUsersForEnvironment: () => Effect.succeed([]),
          listPublicKeysForEnvironment: () => Effect.succeed([]),
          listForUser: () => Effect.succeed([]),
          getForUser: () => Effect.succeed(null),
          revokeForUser: () => Effect.succeed(false),
          retireForUser: () => Effect.succeed(null),
          revokeOtherUsersForEnvironmentKey:
            input?.revokeOtherUsersForEnvironmentKey ?? (() => Effect.succeed([])),
        }),
        Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
          create: () => Effect.succeed("t3env_credential_secret"),
          authenticate: () => Effect.succeedNone,
          revokeForEnvironmentPublicKey: () => Effect.succeed(false),
        }),
        Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
          prepareDeprovision: () => Effect.succeed(null),
          deprovision: input?.deprovision ?? (() => Effect.void),
          release: () => Effect.succeed(true),
          provision:
            input?.provision ??
            (() =>
              Effect.succeed({
                endpoint: {
                  httpBaseUrl: "https://managed.example.test/",
                  wsBaseUrl: "wss://managed.example.test/ws",
                  providerKind: "cloudflare_tunnel",
                },
                runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
              })),
        }),
      ),
    ),
  );
}

describe("EnvironmentLinker", () => {
  it.effect("rejects a remotely retired identity before provisioning", () => {
    let provisioned = false;
    let persisted = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequestFor(true);
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkRetired(result.failure)).toBe(true);
      }
      expect(provisioned).toBe(false);
      expect(persisted).toBe(false);
    }).pipe(
      Effect.provide(
        testLayer({
          ensureRelinkAllowed: () =>
            Effect.fail(
              new EnvironmentLinks.EnvironmentLinkRetired({
                userId: "user_123",
                environmentId: "env-link-test",
              }),
            ),
          provision: () =>
            Effect.sync(() => {
              provisioned = true;
              return {
                endpoint: {
                  httpBaseUrl: "https://managed.example.test/",
                  wsBaseUrl: "wss://managed.example.test/ws",
                  providerKind: "cloudflare_tunnel" as const,
                },
                runtime: {
                  providerKind: "cloudflare_tunnel" as const,
                  connectorToken: "connector-token",
                },
              };
            }),
          upsert: () =>
            Effect.sync(() => {
              persisted = true;
            }),
        }),
      ),
    );
  });

  it.effect("cleans a managed allocation when retirement wins the upsert race", () => {
    let deprovisioned = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequestFor(true);
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkRetired(result.failure)).toBe(true);
      }
      expect(deprovisioned).toBe(true);
    }).pipe(
      Effect.provide(
        testLayer({
          provision: () =>
            Effect.succeed({
              endpoint: {
                httpBaseUrl: "https://managed.example.test/",
                wsBaseUrl: "wss://managed.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              runtime: {
                providerKind: "cloudflare_tunnel",
                connectorToken: "connector-token",
              },
            }),
          upsert: () =>
            Effect.fail(
              new EnvironmentLinks.EnvironmentLinkRetired({
                userId: "user_123",
                environmentId: "env-link-test",
              }),
            ),
          deprovision: () =>
            Effect.sync(() => {
              deprovisioned = true;
            }),
        }),
      ),
    );
  });

  it.effect("allows a managed HTTP endpoint only on a loopback localhost name", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequestFor(true);
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.endpoint).toEqual({
        httpBaseUrl: "http://sovereign-proof-0123456789abcdef.localhost:5733/",
        wsBaseUrl: "ws://sovereign-proof-0123456789abcdef.localhost:5733/ws",
        providerKind: "cloudflare_tunnel",
      });
    }).pipe(
      Effect.provide(
        testLayer({
          provision: () =>
            Effect.succeed({
              endpoint: {
                httpBaseUrl: "http://sovereign-proof-0123456789abcdef.localhost:5733/",
                wsBaseUrl: "ws://sovereign-proof-0123456789abcdef.localhost:5733/ws",
                providerKind: "cloudflare_tunnel",
              },
              runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
            }),
        }),
      ),
    ),
  );

  it.effect("rejects a managed HTTP endpoint on a non-loopback name", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequestFor(true);
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          reason: "endpoint_not_secure",
          stage: "validate_endpoint",
        });
      }
    }).pipe(
      Effect.provide(
        testLayer({
          provision: () =>
            Effect.succeed({
              endpoint: {
                httpBaseUrl: "http://environment.example.test:5733/",
                wsBaseUrl: "ws://environment.example.test:5733/ws",
                providerKind: "cloudflare_tunnel",
              },
              runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
            }),
        }),
      ),
    ),
  );

  it.effect("uses verified JWT claims when linking an environment", () => {
    let persistedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const { request, payload } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentId).toBe(payload.environmentId);
      expect(result.environmentCredential).toBe("t3env_credential_secret");
      expect(persistedEnvironmentId).toBe(payload.environmentId);
    }).pipe(
      Effect.provide(
        testLayer({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEnvironmentId = input.proof.environmentId;
            }),
        }),
      ),
    );
  });

  it.effect("explicitly transfers only links for the same environment signing key", () => {
    const transferRequests: Array<{
      readonly userId: string;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }> = [];
    const deprovisionedUsers: string[] = [];
    return Effect.gen(function* () {
      const { request, payload } = yield* makeRequestFor(true, true);
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      yield* linker.link({ userId: "user_123", request });

      expect(transferRequests).toEqual([
        {
          userId: "user_123",
          environmentId: payload.environmentId,
          environmentPublicKey: payload.environmentPublicKey,
        },
      ]);
      expect(deprovisionedUsers).toEqual(["previous-owner", "shared-user"]);
    }).pipe(
      Effect.provide(
        testLayer({
          revokeOtherUsersForEnvironmentKey: (input) =>
            Effect.sync(() => {
              transferRequests.push(input);
              return ["previous-owner", "shared-user"];
            }),
          deprovision: ({ userId }) =>
            Effect.sync(() => {
              deprovisionedUsers.push(userId);
            }),
        }),
      ),
    );
  });

  it.effect("links a publish-only environment with a non-secure nominal endpoint", () => {
    let persistedEndpoint: string | null = null;
    let deprovisionedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 5 });
      const relayTokens = yield* RelayTokens.RelayTokens;
      const challenge = yield* relayTokens.issueLinkChallenge({
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: false,
          transferExistingLinks: false,
        },
        jti: "publish-only-challenge-jti",
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
      });
      const payload = {
        iss: "t3-env:env-link-test",
        aud: "https://relay.example.test",
        sub: "env-link-test",
        jti: "publish-only-proof-jti",
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        challenge,
        environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
        descriptor: {
          environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
          label: "Link Test Environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        environmentPublicKey: environmentKeyPair.publicKey.trim(),
        endpoint: {
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          providerKind: "manual",
        },
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        scopes: ["agent_activity_notifications"],
      } satisfies RelayEnvironmentLinkProofPayload;
      const request = {
        proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: false,
        transferExistingLinks: false,
      } satisfies RelayEnvironmentLinkRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentCredential).toBe("t3env_credential_secret");
      expect(result.endpointRuntime).toBeNull();
      expect(persistedEndpoint).toBe("http://127.0.0.1:3773/");
      // Downgrading from a managed link must release the previously provisioned
      // tunnel; nothing else cleans it up before a full unlink.
      expect(deprovisionedEnvironmentId).toBe("env-link-test");
    }).pipe(
      Effect.provide(
        testLayer({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEndpoint = input.endpoint.httpBaseUrl;
            }),
          deprovision: (input) =>
            Effect.sync(() => {
              deprovisionedEnvironmentId = input.environmentId;
            }),
        }),
      ),
    );
  });

  it.effect("rejects a tampered compact proof before persistence", () => {
    let persisted = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const segments = request.proof.split(".");
      const signature = segments[2]!;
      segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      const tampered = { ...request, proof: segments.join(".") };
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request: tampered }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "invalid_signature_or_scope",
            stage: "verify_proof",
            cause: { _tag: "RelayJwtError" },
          });
        }
      }
      expect(persisted).toBe(false);
    }).pipe(
      Effect.provide(
        testLayer({
          upsert: () =>
            Effect.sync(() => {
              persisted = true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects replayed JWT ids", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "replayed_nonce",
            stage: "consume_proof_nonce",
          });
        }
      }
    }).pipe(Effect.provide(testLayer({ consume: () => Effect.succeed(false) }))),
  );
});
