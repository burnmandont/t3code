import { OrchestrationGetSnapshotError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

export const THREAD_LIVE_BUFFER_CAPACITY = 256;

export interface ThreadLiveBuffer<A> {
  readonly queue: Queue.Queue<A, OrchestrationGetSnapshotError>;
  readonly threadId: ThreadId;
}

export const makeThreadLiveBuffer = <A>(
  threadId: ThreadId,
  capacity = THREAD_LIVE_BUFFER_CAPACITY,
): Effect.Effect<ThreadLiveBuffer<A>> =>
  Queue.dropping<A, OrchestrationGetSnapshotError>(capacity).pipe(
    Effect.map((queue) => ({ queue, threadId })),
  );

/**
 * Offers without blocking the orchestration publisher. Overflow fails the
 * queue after its admitted frames are consumed, so the subscriber reconnects
 * from the last sequence it actually applied instead of silently skipping.
 */
export const offerThreadLiveItem = <A>(
  buffer: ThreadLiveBuffer<A>,
  item: A,
): Effect.Effect<boolean> =>
  Queue.offer(buffer.queue, item).pipe(
    Effect.flatMap((offered) =>
      offered
        ? Effect.succeed(true)
        : Queue.fail(
            buffer.queue,
            new OrchestrationGetSnapshotError({
              message: `Thread ${buffer.threadId} live delivery fell behind; reconnecting from the last sequence`,
            }),
          ).pipe(Effect.as(false)),
    ),
  );
