import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../RelayDbService.ts";
import { relayApnsDeliveryJobs } from "../persistence/schema.ts";
import type { SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as SovereignApnsQueue from "./SovereignApnsQueue.ts";

const job: SignedApnsDeliveryJob = {
  algorithm: "hmac-sha256",
  payload: {
    version: 1,
    jobId: "push:v1:logical-delivery",
    kind: "push_notification",
    target: {
      userId: "user-1",
      deviceId: "device-1",
      token: "push-token",
    },
    aggregate: null,
    notification: {
      title: "Thread",
      body: "Input: Project",
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
      phase: "waiting_for_input",
      updatedAt: "2026-08-17T00:00:00.000Z",
    },
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T00:10:00.000Z",
  },
  signature: "signature",
};

describe("sovereign APNs queue", () => {
  it("backs retries off exponentially and caps the delay", () => {
    expect([1, 2, 3, 4, 5, 6].map(SovereignApnsQueue.retryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it("does not produce a sub-thirty-second delay for defensive zero input", () => {
    expect(SovereignApnsQueue.retryDelayMs(0)).toBe(30_000);
  });

  it.effect("treats duplicate logical delivery jobs as successful enqueues", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const conflictTargets: unknown[] = [];
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayApnsDeliveryJobs);
        return {
          values: (values: Record<string, unknown>) => {
            inserted.push(values);
            return {
              onConflictDoNothing: (config: { readonly target: unknown }) => {
                conflictTargets.push(config.target);
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const repository = yield* SovereignApnsQueue.SovereignApnsQueueRepository;
      yield* repository.enqueue(job);
      yield* repository.enqueue(job);

      expect(inserted).toHaveLength(2);
      expect(inserted).toMatchObject([
        { jobId: job.payload.jobId, state: "pending" },
        { jobId: job.payload.jobId, state: "pending" },
      ]);
      expect(conflictTargets).toEqual([relayApnsDeliveryJobs.jobId, relayApnsDeliveryJobs.jobId]);
    }).pipe(
      Effect.provide(
        SovereignApnsQueue.repositoryLayer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });
});
