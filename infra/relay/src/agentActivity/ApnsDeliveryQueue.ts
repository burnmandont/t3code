import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  RelayDeliveryKind as RelayDeliveryKindSchema,
  type RelayDeliveryResult,
} from "@t3tools/contracts/relay";

import {
  sanitizeAgentActivityAggregateState,
  sanitizeApnsNotificationPayload,
} from "./agentActivityPayloads.ts";
import {
  expiresAtForJob,
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  type ApnsDeliveryJobPayload,
  type SignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";
import * as RelayConfiguration from "../Config.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";

export class ApnsDeliveryQueueSendError extends Schema.TaggedErrorClass<ApnsDeliveryQueueSendError>()(
  "ApnsDeliveryQueueSendError",
  {
    operation: Schema.Literals(["generate-job-id", "send"]),
    jobId: Schema.NullOr(Schema.String),
    kind: RelayDeliveryKindSchema,
    userId: Schema.String,
    deviceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to enqueue APNs ${this.kind.replaceAll("_", " ")} delivery during ${this.operation} for device ${this.deviceId}.`;
  }
}

export type ApnsDeliveryQueueError = ApnsDeliveryQueueSendError;

export class ApnsDeliveryQueueSenderError extends Schema.TaggedErrorClass<ApnsDeliveryQueueSenderError>()(
  "ApnsDeliveryQueueSenderError",
  {
    cause: Schema.Defect(),
  },
) {}

export class ApnsDeliveryQueueSender extends Context.Service<
  ApnsDeliveryQueueSender,
  {
    readonly send: (
      body: SignedApnsDeliveryJob,
    ) => Effect.Effect<void, ApnsDeliveryQueueSenderError>;
  }
>()("t3code-relay/agentActivity/ApnsDeliveryQueue/ApnsDeliveryQueueSender") {}

export class ApnsDeliveryQueue extends Context.Service<
  ApnsDeliveryQueue,
  {
    readonly enqueueLiveActivity: (input: {
      readonly kind: ApnsDeliveryJobPayload["kind"];
      readonly userId: string;
      readonly deviceId: string;
      readonly token: string;
      readonly bundleId?: string | null;
      readonly apsEnvironment?: "sandbox" | "production" | null;
      readonly aggregate: ApnsDeliveryJobPayload["aggregate"];
      readonly alert?: ApnsDeliveryJobPayload["alert"];
    }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryQueueError>;
    readonly enqueuePushNotification: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly token: string;
      readonly bundleId?: string | null;
      readonly apsEnvironment?: "sandbox" | "production" | null;
      readonly notification: NonNullable<ApnsDeliveryJobPayload["notification"]>;
    }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryQueueError>;
  }
>()("t3code-relay/agentActivity/ApnsDeliveryQueue") {}

export const make = Effect.gen(function* () {
  const sender = yield* ApnsDeliveryQueueSender;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration.RelayConfiguration;

  // Queue retries keep their ordinary source-job identity. Notification state
  // replays additionally converge on this logical identity, so a server
  // restart cannot enqueue a fresh alert for an already delivered transition.
  const makePushNotificationJobId = Effect.fnUntraced(function* (input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly notification: NonNullable<ApnsDeliveryJobPayload["notification"]>;
  }) {
    if (input.notification.phase === undefined || input.notification.updatedAt === undefined) {
      return yield* crypto.randomUUIDv4;
    }
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(
        stableStringify({
          version: 1,
          userId: input.userId,
          deviceId: input.deviceId,
          environmentId: input.notification.environmentId,
          threadId: input.notification.threadId,
          phase: input.notification.phase,
          updatedAt: input.notification.updatedAt,
        }),
      ),
    );
    return `push:v1:${Encoding.encodeBase64Url(digest)}`;
  });

  return ApnsDeliveryQueue.of({
    enqueueLiveActivity: Effect.fn("relay.apns_delivery_queue.enqueue_live_activity")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
          "relay.delivery.kind": input.kind,
        });
        const now = yield* DateTime.now;
        const jobId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new ApnsDeliveryQueueSendError({
                operation: "generate-job-id",
                jobId: null,
                kind: input.kind,
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
        yield* Effect.annotateCurrentSpan({ "relay.delivery.job_id": jobId });
        const payload = makeApnsDeliveryJobPayload({
          ...input,
          aggregate:
            input.aggregate === null ? null : sanitizeAgentActivityAggregateState(input.aggregate),
          jobId,
          createdAt: DateTime.formatIso(now),
          expiresAt: expiresAtForJob(now.epochMilliseconds),
        });
        const signed = signApnsDeliveryJob({
          secret: config.apnsDeliveryJobSigningSecret,
          payload,
        });
        yield* sender.send(signed).pipe(
          Effect.mapError(
            (cause) =>
              new ApnsDeliveryQueueSendError({
                operation: "send",
                jobId,
                kind: input.kind,
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
        return {
          deviceId: input.deviceId,
          kind: input.kind,
          ok: true,
          queued: true,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      },
    ),
    enqueuePushNotification: Effect.fn("relay.apns_delivery_queue.enqueue_push_notification")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
          "relay.delivery.kind": "push_notification",
          "relay.environment_id": input.notification.environmentId,
          "relay.thread_id": input.notification.threadId,
        });
        const now = yield* DateTime.now;
        const jobId = yield* makePushNotificationJobId(input).pipe(
          Effect.mapError(
            (cause) =>
              new ApnsDeliveryQueueSendError({
                operation: "generate-job-id",
                jobId: null,
                kind: "push_notification",
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
        yield* Effect.annotateCurrentSpan({ "relay.delivery.job_id": jobId });
        const payload = makeApnsDeliveryJobPayload({
          kind: "push_notification",
          userId: input.userId,
          deviceId: input.deviceId,
          token: input.token,
          bundleId: input.bundleId,
          apsEnvironment: input.apsEnvironment,
          aggregate: null,
          notification: sanitizeApnsNotificationPayload(input.notification),
          jobId,
          createdAt: DateTime.formatIso(now),
          expiresAt: expiresAtForJob(now.epochMilliseconds),
        });
        const signed = signApnsDeliveryJob({
          secret: config.apnsDeliveryJobSigningSecret,
          payload,
        });
        yield* sender.send(signed).pipe(
          Effect.mapError(
            (cause) =>
              new ApnsDeliveryQueueSendError({
                operation: "send",
                jobId,
                kind: "push_notification",
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
        return {
          deviceId: input.deviceId,
          kind: "push_notification" as const,
          ok: true,
          queued: true,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      },
    ),
  });
});

export const layer = Layer.effect(ApnsDeliveryQueue, make);

export const layerCloudflareQueues = (
  sender: Cloudflare.Queues.WriteQueueClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        ApnsDeliveryQueueSender,
        ApnsDeliveryQueueSender.of({
          send: (body) =>
            sender.send(body).pipe(
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
              Effect.mapError((cause) => new ApnsDeliveryQueueSenderError({ cause })),
            ),
        }),
      ),
    ),
  );
