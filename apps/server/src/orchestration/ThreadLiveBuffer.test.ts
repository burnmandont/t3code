import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { makeThreadLiveBuffer, offerThreadLiveItem } from "./ThreadLiveBuffer.ts";

it.effect("bounds slow thread consumers and fails after admitted items drain", () =>
  Effect.gen(function* () {
    const buffer = yield* makeThreadLiveBuffer<number>(ThreadId.make("thread-slow"), 3);

    assert.isTrue(yield* offerThreadLiveItem(buffer, 10));
    assert.isTrue(yield* offerThreadLiveItem(buffer, 11));
    assert.isTrue(yield* offerThreadLiveItem(buffer, 12));
    assert.isFalse(yield* offerThreadLiveItem(buffer, 13));

    assert.deepEqual(yield* Queue.takeAll(buffer.queue), [10, 11, 12]);
    const terminal = yield* Effect.result(Queue.take(buffer.queue));
    assert.equal(terminal._tag, "Failure");
    if (terminal._tag === "Failure") {
      assert.equal(terminal.failure._tag, "OrchestrationGetSnapshotError");
    }
  }),
);
