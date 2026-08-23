import {
  connect,
  constants as http2Constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type OutgoingHttpHeaders,
} from "node:http2";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Apns from "./ApnsClient.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

const REQUEST_TIMEOUT_MS = 15_000;

interface Http2Response {
  readonly status: number;
  readonly body: string;
  readonly apnsId: string | null;
}

interface Http2Failure {
  readonly stage: "send" | "read-response";
  readonly status: number | null;
  readonly cause: unknown;
}

function firstHeader(value: string | ReadonlyArray<string> | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.[0] ?? null;
}

/**
 * Apple's provider API requires HTTP/2. The ordinary Node HttpClient used by
 * the rest of the sovereign relay is HTTP/1.1, so APNs uses this narrow native
 * transport instead of relying on Cloudflare's platform negotiation.
 */
export function sendHttp2ApnsRequest(input: {
  readonly origin: string;
  readonly path: string;
  readonly headers: OutgoingHttpHeaders;
  readonly payload: unknown;
}): Promise<Http2Response> {
  return new Promise((resolve, reject: (failure: Http2Failure) => void) => {
    let session: ClientHttp2Session | undefined;
    let request: ClientHttp2Stream | undefined;
    let status: number | null = null;
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      request?.removeAllListeners();
      session?.removeAllListeners();
      request?.close();
      session?.destroy();
      operation();
    };
    const fail = (stage: Http2Failure["stage"], cause: unknown) =>
      finish(() => reject({ stage, status, cause }));

    try {
      session = connect(input.origin);
      session.once("error", (cause) => fail(status === null ? "send" : "read-response", cause));
      request = session.request({
        [http2Constants.HTTP2_HEADER_METHOD]: "POST",
        [http2Constants.HTTP2_HEADER_PATH]: input.path,
        [http2Constants.HTTP2_HEADER_SCHEME]: "https",
        "content-type": "application/json",
        ...input.headers,
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => fail("read-response", new Error("timeout")));
      request.once("response", (headers) => {
        const receivedStatus = headers[http2Constants.HTTP2_HEADER_STATUS];
        status = typeof receivedStatus === "number" ? receivedStatus : Number(receivedStatus);
        const apnsId = firstHeader(headers["apns-id"]);
        request?.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request?.once("end", () =>
          finish(() =>
            resolve({
              status: status ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              apnsId,
            }),
          ),
        );
      });
      request.once("error", (cause) => fail(status === null ? "send" : "read-response", cause));
      request.end(JSON.stringify(input.payload));
    } catch (cause) {
      fail("send", cause);
    }
  });
}

export const make = Effect.gen(function* () {
  const providerTokens = yield* ApnsProviderTokens.ApnsProviderTokens;

  const send = Effect.fnUntraced(function* (input: {
    readonly credentials: Parameters<
      Apns.ApnsClient["Service"]["sendLiveActivityRequest"]
    >[0]["credentials"];
    readonly issuedAtUnixSeconds: number;
    readonly requestKind: "live-activity" | "push-notification";
    readonly event: Apns.ApnsLiveActivityEvent | null;
    readonly token: string;
    readonly priority: "5" | "10";
    readonly payload: unknown;
  }) {
    const jwt = yield* providerTokens.getJwt({
      ...input.credentials,
      issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    });
    const origin =
      input.credentials.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const response = yield* Effect.tryPromise({
      try: () =>
        sendHttp2ApnsRequest({
          origin,
          path: `/3/device/${input.token}`,
          headers: {
            authorization: `bearer ${jwt}`,
            "apns-priority": input.priority,
            "apns-push-type": input.requestKind === "live-activity" ? "liveactivity" : "alert",
            "apns-topic":
              input.requestKind === "live-activity"
                ? `${input.credentials.bundleId}.push-type.liveactivity`
                : input.credentials.bundleId,
          },
          payload: input.payload,
        }),
      catch: (failure) => {
        const normalized = failure as Http2Failure;
        return new Apns.ApnsHttpRequestError({
          requestKind: input.requestKind,
          event: input.event,
          environment: input.credentials.environment,
          bundleId: input.credentials.bundleId,
          tokenSuffix: input.token.slice(-8),
          stage: normalized.stage ?? "send",
          status: normalized.status ?? null,
          cause: normalized.cause ?? failure,
        });
      },
    });
    const reason = Apns.apnsReasonFromBody(response.body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      apnsId: response.apnsId,
    };
  });

  return Apns.ApnsClient.of({
    makeLiveActivityRequest: Apns.makeLiveActivityRequest,
    makePushNotificationRequest: Apns.makePushNotificationRequest,
    sendLiveActivityRequest: Effect.fn("relay.apns.send_live_activity_request")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.apns.event": input.request.event });
      return yield* send({
        credentials: input.credentials,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
        requestKind: "live-activity",
        event: input.request.event,
        token: input.request.token,
        priority: input.request.priority,
        payload: input.request.payload,
      });
    }),
    sendPushNotificationRequest: Effect.fn("relay.apns.send_push_notification_request")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.apns.event": "push_notification" });
        return yield* send({
          credentials: input.credentials,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          requestKind: "push-notification",
          event: null,
          token: input.request.token,
          priority: input.request.priority,
          payload: input.request.payload,
        });
      },
    ),
  });
});

export const layer = Layer.effect(Apns.ApnsClient, make);
