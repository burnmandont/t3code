// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer requires createServer
import * as NodeHttp from "node:http";

import { NodeHttpClient, NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as SovereignApnsClient from "./agentActivity/SovereignApnsClient.ts";
import * as SovereignApnsQueue from "./agentActivity/SovereignApnsQueue.ts";
import * as RelayIdentityVerifierOidc from "./auth/RelayIdentityVerifierOidc.ts";
import * as RelayConfiguration from "./Config.ts";
import * as ManagedEndpointProviderT3 from "./environments/ManagedEndpointProviderT3.ts";
import * as SovereignConnectorConfiguration from "./environments/SovereignConnectorConfiguration.ts";
import * as FrpAuthorization from "./frp/FrpAuthorization.ts";
import * as FrpHttpApp from "./frp/FrpHttpApp.ts";
import { traceRelayHttpRequest } from "./http/Api.ts";
import * as RelayDb from "./RelayDbService.ts";
import * as RelayHttpApp from "./RelayHttpApp.ts";
import * as RelayMaintenance from "./RelayMaintenance.ts";
import * as RelayRuntime from "./RelayRuntime.ts";
import { makeSovereignObservabilityLayer } from "./sovereignObservability.ts";

interface SovereignRuntimeConfiguration {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly relayIssuer: string;
  readonly relayHost: string;
  readonly relayPort: number;
  readonly relayAllowedOrigins: ReadonlyArray<string>;
  readonly frpPluginHost: string;
  readonly frpPluginPort: number;
  readonly frpsServerAddr: string;
  readonly frpsServerPort: number;
  readonly managedEndpointBaseDomain: string;
  readonly managedEndpointNamespace: string;
  readonly managedEndpointHttpScheme: "http" | "https";
  readonly managedEndpointHttpPort: number | undefined;
  readonly managedEndpointDialOrigin: string | undefined;
  readonly managedEndpointDialHost: string | undefined;
  readonly oidcIssuer: string;
  readonly oidcAudience: string;
  readonly oidcJwksUrl: string;
  readonly oidcRequiredScope: string;
  readonly cloudMintPrivateKey: Redacted.Redacted<string>;
  readonly cloudMintPublicKey: string;
  readonly apnsEnabled: boolean;
  readonly apnsEnvironment: RelayConfiguration.ApnsEnvironment;
  readonly apnsTeamId: string;
  readonly apnsKeyId: string;
  readonly apnsBundleId: string;
  readonly apnsPrivateKeyBase64: Redacted.Redacted<string>;
  readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpAuthorization: Redacted.Redacted<string> | undefined;
}

export const parseRelayAllowedOrigins = (value: string): ReadonlyArray<string> => [
  ...new Set(value.split(",").map((entry) => normalizeRelayAllowedOrigin(entry.trim()))),
];

const normalizeRelayAllowedOrigin = (candidate: string): string => {
  const url = new URL(candidate);
  if (url.origin !== "null") {
    return url.origin;
  }
  if (
    url.host.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new TypeError(`Invalid host-based custom origin: ${candidate}`);
  }
  return `${url.protocol}//${url.host}`;
};

const loadConfiguration: Effect.Effect<SovereignRuntimeConfiguration, Config.ConfigError> =
  Config.all({
    databaseUrl: Config.redacted("T3_RELAY_DATABASE_URL"),
    relayIssuer: Config.string("T3_RELAY_ISSUER"),
    relayHost: Config.string("T3_RELAY_HOST").pipe(Config.withDefault("127.0.0.1")),
    relayPort: Config.port("T3_RELAY_PORT").pipe(Config.withDefault(4100)),
    relayAllowedOrigins: Config.string("T3_RELAY_ALLOWED_ORIGINS").pipe(
      Config.map(parseRelayAllowedOrigins),
    ),
    frpPluginHost: Config.string("T3_FRP_PLUGIN_HOST").pipe(Config.withDefault("127.0.0.1")),
    frpPluginPort: Config.port("T3_FRP_PLUGIN_PORT").pipe(Config.withDefault(4101)),
    frpsServerAddr: Config.string("T3_FRPS_SERVER_ADDR"),
    frpsServerPort: Config.port("T3_FRPS_SERVER_PORT").pipe(Config.withDefault(7000)),
    managedEndpointBaseDomain: Config.string("T3_MANAGED_ENDPOINT_BASE_DOMAIN"),
    managedEndpointNamespace: Config.string("T3_MANAGED_ENDPOINT_NAMESPACE").pipe(
      Config.withDefault("sovereign"),
    ),
    managedEndpointHttpScheme: Config.literals(
      ["http", "https"],
      "T3_MANAGED_ENDPOINT_HTTP_SCHEME",
    ).pipe(Config.withDefault("https" as const)),
    managedEndpointHttpPort: Config.option(Config.port("T3_MANAGED_ENDPOINT_HTTP_PORT")).pipe(
      Config.map((value) => (value._tag === "Some" ? value.value : undefined)),
    ),
    managedEndpointDialOrigin: Config.option(Config.url("T3_MANAGED_ENDPOINT_DIAL_ORIGIN")).pipe(
      Config.map((value) => (value._tag === "Some" ? value.value.origin : undefined)),
    ),
    managedEndpointDialHost: Config.option(
      Config.nonEmptyString("T3_MANAGED_ENDPOINT_DIAL_HOST"),
    ).pipe(Config.map((value) => (value._tag === "Some" ? value.value : undefined))),
    oidcIssuer: Config.string("T3_OIDC_ISSUER"),
    oidcAudience: Config.string("T3_OIDC_AUDIENCE"),
    oidcJwksUrl: Config.string("T3_OIDC_JWKS_URL"),
    oidcRequiredScope: Config.string("T3_OIDC_REQUIRED_SCOPE").pipe(Config.withDefault("t3:relay")),
    cloudMintPrivateKey: Config.redacted("T3_RELAY_SIGNING_PRIVATE_KEY"),
    cloudMintPublicKey: Config.string("T3_RELAY_SIGNING_PUBLIC_KEY"),
    apnsEnabled: Config.boolean("T3_APNS_ENABLED").pipe(Config.withDefault(false)),
    apnsEnvironment: Config.schema(RelayConfiguration.ApnsEnvironment, "T3_APNS_ENVIRONMENT").pipe(
      Config.withDefault("sandbox" as const),
    ),
    apnsTeamId: Config.string("T3_APNS_TEAM_ID").pipe(Config.withDefault("")),
    apnsKeyId: Config.string("T3_APNS_KEY_ID").pipe(Config.withDefault("")),
    apnsBundleId: Config.string("T3_APNS_BUNDLE_ID").pipe(Config.withDefault("")),
    apnsPrivateKeyBase64: Config.redacted("T3_APNS_PRIVATE_KEY_B64").pipe(
      Config.withDefault(Redacted.make("")),
    ),
    apnsDeliveryJobSigningSecret: Config.redacted("T3_APNS_DELIVERY_JOB_SIGNING_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    ),
    otlpTracesUrl: Config.option(Config.url("T3_OTLP_TRACES_URL")).pipe(
      Config.map((value) => (value._tag === "Some" ? value.value.toString() : undefined)),
    ),
    otlpMetricsUrl: Config.option(Config.url("T3_OTLP_METRICS_URL")).pipe(
      Config.map((value) => (value._tag === "Some" ? value.value.toString() : undefined)),
    ),
    otlpAuthorization: Config.option(Config.redacted("T3_OTLP_AUTHORIZATION")).pipe(
      Config.map((value) => (value._tag === "Some" ? value.value : undefined)),
    ),
  });

function sovereignApnsConfiguration(config: SovereignRuntimeConfiguration) {
  if (!config.apnsEnabled) {
    return null;
  }
  const privateKey = Buffer.from(Redacted.value(config.apnsPrivateKeyBase64), "base64").toString(
    "utf8",
  );
  const required = {
    T3_APNS_TEAM_ID: config.apnsTeamId,
    T3_APNS_KEY_ID: config.apnsKeyId,
    T3_APNS_BUNDLE_ID: config.apnsBundleId,
    T3_APNS_PRIVATE_KEY_B64: privateKey,
    T3_APNS_DELIVERY_JOB_SIGNING_SECRET: Redacted.value(config.apnsDeliveryJobSigningSecret),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value.trim().length === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new TypeError(`T3_APNS_ENABLED requires ${missing.join(", ")}`);
  }
  if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new TypeError("T3_APNS_PRIVATE_KEY_B64 must decode to an APNs .p8 private key");
  }
  if (Redacted.value(config.apnsDeliveryJobSigningSecret).length < 32) {
    throw new TypeError("T3_APNS_DELIVERY_JOB_SIGNING_SECRET must contain at least 32 characters");
  }
  return {
    credentials: {
      environment: config.apnsEnvironment,
      teamId: config.apnsTeamId,
      keyId: config.apnsKeyId,
      bundleId: config.apnsBundleId,
      privateKey: Redacted.make(privateKey),
    },
    signingSecret: config.apnsDeliveryJobSigningSecret,
  };
}

export const makeSovereignRelayLayer = (config: SovereignRuntimeConfiguration) => {
  const sovereignApns = sovereignApnsConfiguration(config);
  const relayConfiguration = RelayConfiguration.layer({
    relayIssuer: config.relayIssuer,
    apns:
      sovereignApns?.credentials ??
      ({
        environment: "sandbox",
        teamId: "disabled",
        keyId: "disabled",
        privateKey: Redacted.make("disabled"),
        bundleId: "disabled",
      } as const),
    apnsDeliveryJobSigningSecret: sovereignApns?.signingSecret ?? Redacted.make("disabled"),
    // The OIDC adapter is injected below. No Clerk request or key is used.
    clerkSecretKey: Redacted.make("disabled"),
    clerkPublishableKey: "disabled",
    clerkJwtAudience: "disabled",
    cloudMintPrivateKey: config.cloudMintPrivateKey,
    cloudMintPublicKey: config.cloudMintPublicKey,
    managedEndpointBaseDomain: config.managedEndpointBaseDomain,
    managedEndpointNamespace: config.managedEndpointNamespace,
    managedEndpointHttpScheme: config.managedEndpointHttpScheme,
    ...(config.managedEndpointHttpPort === undefined
      ? {}
      : { managedEndpointHttpPort: config.managedEndpointHttpPort }),
    ...(config.managedEndpointDialOrigin === undefined
      ? {}
      : { managedEndpointDialOrigin: config.managedEndpointDialOrigin }),
    ...(config.managedEndpointDialHost === undefined
      ? {}
      : { managedEndpointDialHost: config.managedEndpointDialHost }),
  });
  const persistence = RelayDb.RelayTransactions.layer.pipe(
    Layer.provideMerge(
      RelayDb.layerPostgres({
        url: config.databaseUrl,
        applicationName: "t3-sovereign-relay",
        maxConnections: 10,
      }),
    ),
  );
  const sovereignApnsRepository = SovereignApnsQueue.repositoryLayer;
  const sovereignApnsDeliveries = ApnsDeliveries.layer.pipe(
    Layer.provideMerge(
      SovereignApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer)),
    ),
    Layer.provideMerge(
      ApnsDeliveryQueue.layer.pipe(
        Layer.provideMerge(
          SovereignApnsQueue.senderLayer.pipe(Layer.provideMerge(sovereignApnsRepository)),
        ),
      ),
    ),
  );
  const runtimeLayer = RelayRuntime.make({
    managedEndpoint: ManagedEndpointProviderT3.layer.pipe(
      Layer.provide(
        SovereignConnectorConfiguration.layer({
          serverAddr: config.frpsServerAddr,
          serverPort: config.frpsServerPort,
        }),
      ),
    ),
    apnsDeliveries: sovereignApns === null ? ApnsDeliveries.layerDisabled : sovereignApnsDeliveries,
    identity: RelayIdentityVerifierOidc.layer({
      issuer: config.oidcIssuer,
      audience: config.oidcAudience,
      jwksUrl: new URL(config.oidcJwksUrl),
      requiredScope: config.oidcRequiredScope,
    }),
    persistence,
    configuration: relayConfiguration,
  });

  const relayServer = HttpRouter.serve(
    RelayHttpApp.makeRelayRoutes({
      allowedOrigins: config.relayAllowedOrigins,
      docs: false,
    }),
    { middleware: traceRelayHttpRequest },
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.relayHost,
        port: config.relayPort,
      }),
    ),
  );
  const frpAuthorizationServer = HttpRouter.serve(FrpHttpApp.route).pipe(
    Layer.provideMerge(FrpAuthorization.layer),
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.frpPluginHost,
        port: config.frpPluginPort,
      }),
    ),
  );

  const apnsWorker =
    sovereignApns === null
      ? Layer.empty
      : SovereignApnsQueue.workerLayer.pipe(Layer.provideMerge(sovereignApnsRepository));
  const observability = makeSovereignObservabilityLayer({
    tracesUrl: config.otlpTracesUrl,
    metricsUrl: config.otlpMetricsUrl,
    authorization: config.otlpAuthorization,
  });

  return Layer.mergeAll(
    relayServer,
    frpAuthorizationServer,
    RelayMaintenance.layerScheduled,
    apnsWorker,
  ).pipe(
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(observability),
    Layer.provideMerge(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(NodeServices.layer),
  );
};

if (import.meta.main) {
  loadConfiguration.pipe(
    Effect.map(makeSovereignRelayLayer),
    Layer.unwrap,
    Layer.launch,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
