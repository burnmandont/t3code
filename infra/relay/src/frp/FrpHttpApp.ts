import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { FrpAuthorization } from "./FrpAuthorization.ts";

export const FRP_AUTHORIZATION_PATH = "/internal/frp/authorize";
const MAX_FRP_PLUGIN_REQUEST_BYTES = 64 * 1024;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const route = HttpRouter.add(
  "POST",
  FRP_AUTHORIZATION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text;
    if (new TextEncoder().encode(body).length > MAX_FRP_PLUGIN_REQUEST_BYTES) {
      return HttpServerResponse.jsonUnsafe({ error: "request_too_large" }, { status: 413 });
    }
    const decoded = yield* decodeJson(body).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_json" }, { status: 400 });
    }
    const authorization = yield* FrpAuthorization;
    return yield* authorization.authorize(decoded.value).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logError("frps authorization persistence request failed", {
            errorType: error._tag,
            operation: error.operation,
          }).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe(
                { error: "authorization_unavailable" },
                { status: 503 },
              ),
            ),
          ),
        onSuccess: (response) => Effect.succeed(HttpServerResponse.jsonUnsafe(response)),
      }),
    );
  }),
);
