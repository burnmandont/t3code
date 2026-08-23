import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { eq } from "drizzle-orm";

import type { SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as RelayDb from "../RelayDbService.ts";
import { relayApnsDeliveryJobs } from "../persistence/schema.ts";

const CLAIM_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_BATCH_SIZE = 10;
const WORKER_INTERVAL = "1 second";

interface ClaimedJob {
  readonly jobId: string;
  readonly bodyJson: SignedApnsDeliveryJob;
  readonly attempts: number;
}

export class SovereignApnsQueuePersistenceError extends Schema.TaggedErrorClass<SovereignApnsQueuePersistenceError>()(
  "SovereignApnsQueuePersistenceError",
  {
    operation: Schema.Literals(["enqueue", "claim", "complete", "retry"]),
    jobId: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist a sovereign APNs queue job during ${this.operation}.`;
  }
}

export class SovereignApnsQueueRepository extends Context.Service<
  SovereignApnsQueueRepository,
  {
    readonly enqueue: (
      body: SignedApnsDeliveryJob,
    ) => Effect.Effect<void, SovereignApnsQueuePersistenceError>;
    readonly claimNext: Effect.Effect<ClaimedJob | null, SovereignApnsQueuePersistenceError>;
    readonly complete: (jobId: string) => Effect.Effect<void, SovereignApnsQueuePersistenceError>;
    readonly retry: (input: {
      readonly jobId: string;
      readonly attempts: number;
      readonly errorCode: string;
    }) => Effect.Effect<void, SovereignApnsQueuePersistenceError>;
  }
>()("t3code-relay/agentActivity/SovereignApnsQueue/SovereignApnsQueueRepository") {}

export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
}

function failureCode(cause: Cause.Cause<unknown>): string {
  const reason = cause.reasons.find(Cause.isFailReason);
  const failure = reason?.error;
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
  ) {
    return failure._tag.slice(0, 128);
  }
  return reason ? "delivery_failed" : "defect_or_interruption";
}

export const repositoryLayer = Layer.effect(
  SovereignApnsQueueRepository,
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;

    const enqueue: SovereignApnsQueueRepository["Service"]["enqueue"] = (body) =>
      Effect.gen(function* () {
        const now = body.payload.createdAt;
        // Logical notification job ids are stable across server replays.
        // Treat an already-pending identity as a successful enqueue.
        yield* db
          .insert(relayApnsDeliveryJobs)
          .values({
            jobId: body.payload.jobId,
            bodyJson: body,
            state: "pending",
            attempts: 0,
            availableAt: now,
            claimedAt: null,
            lastErrorCode: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: relayApnsDeliveryJobs.jobId });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SovereignApnsQueuePersistenceError({
              operation: "enqueue",
              jobId: body.payload.jobId,
              cause,
            }),
        ),
      );

    const claimNext = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const leaseExpiredBefore = DateTime.formatIso(
        DateTime.subtract(now, { milliseconds: CLAIM_LEASE_MS }),
      );
      const rows = yield* db.$client.unsafe<{
        job_id: string;
        body_json: SignedApnsDeliveryJob;
        attempts: number;
      }>(
        `WITH candidate AS (
           SELECT job_id
           FROM relay_apns_delivery_jobs
           WHERE state = 'pending'
             AND available_at <= $1
             AND (claimed_at IS NULL OR claimed_at <= $2)
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE relay_apns_delivery_jobs AS jobs
         SET claimed_at = $1,
             attempts = jobs.attempts + 1,
             updated_at = $1
         FROM candidate
         WHERE jobs.job_id = candidate.job_id
         RETURNING jobs.job_id, jobs.body_json, jobs.attempts`,
        [nowIso, leaseExpiredBefore],
      );
      const row = rows[0];
      return row ? { jobId: row.job_id, bodyJson: row.body_json, attempts: row.attempts } : null;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SovereignApnsQueuePersistenceError({
            operation: "claim",
            jobId: null,
            cause,
          }),
      ),
    );

    const complete: SovereignApnsQueueRepository["Service"]["complete"] = (jobId) =>
      db
        .delete(relayApnsDeliveryJobs)
        .where(eq(relayApnsDeliveryJobs.jobId, jobId))
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new SovereignApnsQueuePersistenceError({
                operation: "complete",
                jobId,
                cause,
              }),
          ),
        );

    const retry: SovereignApnsQueueRepository["Service"]["retry"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const deadLetter = input.attempts >= MAX_ATTEMPTS;
        const availableAt = deadLetter
          ? DateTime.formatIso(now)
          : DateTime.formatIso(DateTime.add(now, { milliseconds: retryDelayMs(input.attempts) }));
        yield* db
          .update(relayApnsDeliveryJobs)
          .set({
            state: deadLetter ? "dead_letter" : "pending",
            availableAt,
            claimedAt: null,
            lastErrorCode: input.errorCode,
            updatedAt: DateTime.formatIso(now),
          })
          .where(eq(relayApnsDeliveryJobs.jobId, input.jobId));
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SovereignApnsQueuePersistenceError({
              operation: "retry",
              jobId: input.jobId,
              cause,
            }),
        ),
      );

    return SovereignApnsQueueRepository.of({ enqueue, claimNext, complete, retry });
  }),
);

export const senderLayer = Layer.effect(
  ApnsDeliveryQueue.ApnsDeliveryQueueSender,
  Effect.gen(function* () {
    const repository = yield* SovereignApnsQueueRepository;
    return ApnsDeliveryQueue.ApnsDeliveryQueueSender.of({
      send: (body) =>
        repository
          .enqueue(body)
          .pipe(
            Effect.mapError(
              (cause) => new ApnsDeliveryQueue.ApnsDeliveryQueueSenderError({ cause }),
            ),
          ),
    });
  }),
);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const repository = yield* SovereignApnsQueueRepository;
    const deliveries = yield* ApnsDeliveries.ApnsDeliveries;

    const processAvailable = Effect.gen(function* () {
      for (let index = 0; index < MAX_BATCH_SIZE; index += 1) {
        const job = yield* repository.claimNext;
        if (job === null) {
          break;
        }
        const exit = yield* Effect.exit(deliveries.processSignedJob(job.bodyJson));
        if (Exit.isSuccess(exit)) {
          yield* repository.complete(job.jobId);
          continue;
        }
        const errorCode = failureCode(exit.cause);
        yield* repository.retry({
          jobId: job.jobId,
          attempts: job.attempts,
          errorCode,
        });
        yield* Effect.logWarning("Sovereign APNs delivery job will be retried", {
          errorCode,
          attempts: job.attempts,
          deadLettered: job.attempts >= MAX_ATTEMPTS,
        });
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Sovereign APNs queue worker pass failed", {
          errorType: error._tag,
          operation: error.operation,
        }),
      ),
    );

    yield* processAvailable.pipe(
      Effect.repeat(Schedule.spaced(WORKER_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
