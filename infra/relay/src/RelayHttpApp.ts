import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayDpopClientAuthLayer,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";

export const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
).pipe(
  Layer.provideMerge(relayClientAuthLayer),
  Layer.provideMerge(relayDpopClientAuthLayer),
  Layer.provideMerge(relayEnvironmentAuthLayer),
);

export const relayHttpEffect = Layer.merge(
  Layer.mergeAll(
    HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(relayApiLayer),
    ),
    HttpApiScalar.layer(RelayApi, { path: "/docs" }),
    relayDocsRedirectRoute,
  ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
  relayNotFoundRoute,
).pipe(HttpRouter.toHttpEffect, withoutCapturedParentSpan);
