import { describe, expect, it } from "vite-plus/test";
import {
  createFollowUpQueueItem,
  dequeueFollowUp,
  enqueueFollowUp,
  removeFollowUp,
  shouldDrainFollowUpQueue,
} from "./followUpQueue";

describe("followUpQueue", () => {
  it("enqueues, removes, and dequeues in FIFO order", () => {
    const first = createFollowUpQueueItem("one", new Date("2026-08-13T00:00:00.000Z"));
    const second = createFollowUpQueueItem("two", new Date("2026-08-13T00:00:01.000Z"));
    const queue = enqueueFollowUp(enqueueFollowUp([], first), second);

    expect(removeFollowUp(queue, first.id).map((item) => item.text)).toEqual(["two"]);
    expect(dequeueFollowUp(queue)).toEqual({
      next: first,
      remaining: [second],
    });
  });

  it("drains only after a successful running → ready settle", () => {
    expect(
      shouldDrainFollowUpQueue({
        previousPhase: "running",
        phase: "ready",
        latestTurnState: "completed",
      }),
    ).toBe(true);
    expect(
      shouldDrainFollowUpQueue({
        previousPhase: "running",
        phase: "ready",
        latestTurnState: "interrupted",
      }),
    ).toBe(false);
    expect(
      shouldDrainFollowUpQueue({
        previousPhase: "ready",
        phase: "ready",
        latestTurnState: "completed",
      }),
    ).toBe(false);
  });
});
