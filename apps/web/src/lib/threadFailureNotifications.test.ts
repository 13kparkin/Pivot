import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  failureActivityDetail,
  isThreadFailureActivityToastable,
  observeThreadFailureActivities,
} from "./threadFailureNotifications";

let nextActivityId = 0;

function activity(
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`failure-${nextActivityId++}`),
    createdAt: "2026-08-16T12:00:00.000Z",
    kind: "provider.text-generation.failed",
    summary: "Could not name this thread",
    tone: "error",
    payload: {},
    turnId: null,
    ...overrides,
  };
}

describe("isThreadFailureActivityToastable", () => {
  it("accepts genuine error-toned failures", () => {
    expect(isThreadFailureActivityToastable(activity())).toBe(true);
    expect(isThreadFailureActivityToastable(activity({ kind: "runtime.error" }))).toBe(true);
    expect(isThreadFailureActivityToastable(activity({ kind: "checkpoint.capture.failed" }))).toBe(
      true,
    );
    expect(isThreadFailureActivityToastable(activity({ kind: "checkpoint.revert.failed" }))).toBe(
      true,
    );
    expect(isThreadFailureActivityToastable(activity({ kind: "provider.turn.start.failed" }))).toBe(
      true,
    );
    expect(isThreadFailureActivityToastable(activity({ kind: "setup-script.failed" }))).toBe(true);
  });

  it("rejects non-error tones", () => {
    expect(isThreadFailureActivityToastable(activity({ tone: "info" }))).toBe(false);
    expect(isThreadFailureActivityToastable(activity({ tone: "tool" }))).toBe(false);
    expect(isThreadFailureActivityToastable(activity({ tone: "approval" }))).toBe(false);
  });

  it("rejects intentional or advisory error-toned activities", () => {
    expect(isThreadFailureActivityToastable(activity({ kind: "tool.denied" }))).toBe(false);
    expect(isThreadFailureActivityToastable(activity({ kind: "advisor.comment" }))).toBe(false);
  });

  it("rejects stale pending-request bookkeeping failures", () => {
    const staleDetails = [
      "Stale pending approval request: req-1",
      "Unknown pending permission request: req-1",
      "Unknown pending user input request: req-1",
      "Stale pending user-input request: req-1",
    ];
    for (const detail of staleDetails) {
      expect(
        isThreadFailureActivityToastable(
          activity({
            kind: "provider.approval.respond.failed",
            payload: { detail },
          }),
        ),
      ).toBe(false);
      expect(
        isThreadFailureActivityToastable(
          activity({
            kind: "provider.user-input.respond.failed",
            payload: { detail },
          }),
        ),
      ).toBe(false);
    }
  });

  it("accepts real pending-response failures", () => {
    expect(
      isThreadFailureActivityToastable(
        activity({
          kind: "provider.approval.respond.failed",
          payload: { detail: "Provider process exited" },
        }),
      ),
    ).toBe(true);
  });
});

describe("failureActivityDetail", () => {
  it("prefers the payload detail over the message", () => {
    expect(
      failureActivityDetail(
        activity({ payload: { detail: "Model not found: openai/gpt-5", message: "nope" } }),
      ),
    ).toBe("Model not found: openai/gpt-5");
  });

  it("falls back to the payload message", () => {
    expect(failureActivityDetail(activity({ payload: { message: "boom" } }))).toBe("boom");
  });

  it("returns undefined when the payload has no failure body", () => {
    expect(failureActivityDetail(activity({ payload: {} }))).toBeUndefined();
  });
});

describe("observeThreadFailureActivities", () => {
  const tracker = (): Map<string, Set<string>> => new Map();

  it("records pre-existing failures seen before the stream is live", () => {
    const seenByThread = tracker();
    const oldFailure = activity();
    expect(observeThreadFailureActivities("thread-1", [oldFailure], false, seenByThread)).toEqual(
      [],
    );
    expect(observeThreadFailureActivities("thread-1", [oldFailure], true, seenByThread)).toEqual(
      [],
    );
  });

  it("toasts a new failure exactly once while live", () => {
    const seenByThread = tracker();
    observeThreadFailureActivities("thread-1", [], false, seenByThread);
    const fresh = activity();
    const first = observeThreadFailureActivities("thread-1", [fresh], true, seenByThread);
    expect(first.map((entry) => entry.id)).toEqual([fresh.id]);
    expect(observeThreadFailureActivities("thread-1", [fresh], true, seenByThread)).toEqual([]);
  });

  it("does not toast failures recorded while not live when the stream goes live", () => {
    const seenByThread = tracker();
    observeThreadFailureActivities("thread-1", [], false, seenByThread);
    const duringSync = activity();
    expect(observeThreadFailureActivities("thread-1", [duringSync], false, seenByThread)).toEqual(
      [],
    );
    expect(observeThreadFailureActivities("thread-1", [duringSync], true, seenByThread)).toEqual(
      [],
    );
  });

  it("toasts pre-existing failures once on servers without completion markers", () => {
    // Legacy edge: the initial snapshot is applied directly as live.
    const seenByThread = tracker();
    const oldFailure = activity();
    expect(observeThreadFailureActivities("thread-1", [oldFailure], true, seenByThread)).toEqual([
      oldFailure,
    ]);
    expect(observeThreadFailureActivities("thread-1", [oldFailure], true, seenByThread)).toEqual(
      [],
    );
  });

  it("ignores non-toastable activities entirely", () => {
    const seenByThread = tracker();
    const denied = activity({ kind: "tool.denied" });
    observeThreadFailureActivities("thread-1", [denied], false, seenByThread);
    expect(observeThreadFailureActivities("thread-1", [denied], true, seenByThread)).toEqual([]);
  });

  it("keeps per-thread state independent", () => {
    const seenByThread = tracker();
    observeThreadFailureActivities("thread-1", [], false, seenByThread);
    const preExisting = activity();
    observeThreadFailureActivities("thread-2", [preExisting], false, seenByThread);
    const fresh = activity();
    expect(
      observeThreadFailureActivities("thread-2", [preExisting, fresh], true, seenByThread).map(
        (entry) => entry.id,
      ),
    ).toEqual([fresh.id]);
  });
});
