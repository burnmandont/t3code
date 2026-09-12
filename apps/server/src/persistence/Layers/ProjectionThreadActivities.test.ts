import { EventId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'latest-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'latest-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'latest-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'latest-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("latest-task-untitled"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("latest-task-blank-title"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["latest-task-untitled", "latest-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({ threadId, taskId: "task-1" });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("latest-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }
      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );
});
