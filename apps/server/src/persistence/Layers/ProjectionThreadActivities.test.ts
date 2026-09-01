import { EventId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("loads only user-input and task lifecycle activity slices", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-activity-slices");
      const createdAt = "2026-08-18T12:00:00.000Z";

      const rows = [
        {
          activityId: EventId.make("activity-tool"),
          kind: "tool.completed",
          payload: { output: "large tool output" },
          sequence: NonNegativeInt.make(0),
        },
        {
          activityId: EventId.make("activity-user-input-requested"),
          kind: "user-input.requested",
          payload: { requestId: "request-1" },
          sequence: NonNegativeInt.make(2),
        },
        {
          activityId: EventId.make("activity-user-input-resolved"),
          kind: "user-input.resolved",
          payload: { requestId: "request-1" },
          sequence: NonNegativeInt.make(3),
        },
        {
          activityId: EventId.make("activity-task-started"),
          kind: "task.started",
          payload: { taskId: "task-1", description: "Inspect server" },
          sequence: NonNegativeInt.make(1),
        },
        {
          activityId: EventId.make("activity-task-progress"),
          kind: "task.progress",
          payload: { taskId: "task-1", description: "Inspecting server" },
        },
      ] as const;

      yield* Effect.forEach(
        rows,
        (row) =>
          repository.upsert({
            ...row,
            threadId,
            turnId: null,
            tone: "info",
            summary: row.kind,
            createdAt,
          }),
        { concurrency: 1 },
      );

      const userInputRows = yield* repository.listUserInputLifecycleByThreadId({ threadId });
      assert.deepEqual(
        userInputRows.map((row) => row.activityId),
        [
          EventId.make("activity-user-input-requested"),
          EventId.make("activity-user-input-resolved"),
        ],
      );

      const taskRows = yield* repository.listTaskLifecycleByThreadId({ threadId });
      assert.deepEqual(
        taskRows.map((row) => row.activityId),
        [EventId.make("activity-task-progress"), EventId.make("activity-task-started")],
      );
    }),
  );
});
