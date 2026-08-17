import { assert, describe, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  MODEL_FAILURE_ACTIVITY_KINDS,
  activityFailureDetail,
  activityFailureTitle,
  findNewModelFailureActivities,
  shouldToastSessionError,
} from "./threadModelFailureToasts.logic";

function activity(overrides: Partial<OrchestrationThreadActivity>): OrchestrationThreadActivity {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    tone: "error",
    kind: "provider.turn.start.failed",
    summary: "Could not start the run",
    payload: {},
    turnId: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

describe("MODEL_FAILURE_ACTIVITY_KINDS", () => {
  it("covers the two model-call failure kinds", () => {
    assert.ok(MODEL_FAILURE_ACTIVITY_KINDS.has("provider.turn.start.failed"));
    assert.ok(MODEL_FAILURE_ACTIVITY_KINDS.has("provider.text-generation.failed"));
  });

  it("excludes control-plane failures that are not model errors", () => {
    assert.equal(MODEL_FAILURE_ACTIVITY_KINDS.has("provider.turn.interrupt.failed"), false);
    assert.equal(MODEL_FAILURE_ACTIVITY_KINDS.has("provider.session.stop.failed"), false);
    assert.equal(MODEL_FAILURE_ACTIVITY_KINDS.has("provider.approval.respond.failed"), false);
    assert.equal(MODEL_FAILURE_ACTIVITY_KINDS.has("provider.user-input.respond.failed"), false);
  });
});

describe("activityFailureDetail", () => {
  it("reads the provider detail from the activity payload", () => {
    const failure = activity({ payload: { detail: "usage limit exceeded" } });
    assert.equal(activityFailureDetail(failure), "usage limit exceeded");
  });

  it("falls back to the summary when the payload has no detail", () => {
    const failure = activity({ payload: {}, summary: "Could not start the run" });
    assert.equal(activityFailureDetail(failure), "Could not start the run");
  });

  it("falls back to the summary for a blank detail", () => {
    const failure = activity({ payload: { detail: "   " } });
    assert.equal(activityFailureDetail(failure), "Could not start the run");
  });
});

describe("activityFailureTitle", () => {
  it("names text-generation failures", () => {
    assert.equal(activityFailureTitle("provider.text-generation.failed"), "Model call failed");
  });

  it("names turn-start failures", () => {
    assert.equal(activityFailureTitle("provider.turn.start.failed"), "Run failed to start");
  });
});

describe("findNewModelFailureActivities", () => {
  it("returns failure activities not in the seen set", () => {
    const seen = activity({ kind: "provider.turn.start.failed" });
    const fresh = activity({ kind: "provider.text-generation.failed" });
    const result = findNewModelFailureActivities([seen, fresh], new Set([seen.id]));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, fresh.id);
  });

  it("ignores non-failure activities even when unseen", () => {
    const tool = activity({ kind: "tool.execution_started" });
    assert.deepEqual(findNewModelFailureActivities([tool], new Set()), []);
  });

  it("does not re-toast an already-seen failure", () => {
    const failure = activity({});
    assert.deepEqual(findNewModelFailureActivities([failure], new Set([failure.id])), []);
  });
});

describe("shouldToastSessionError", () => {
  it("toasts a new mid-run failure", () => {
    assert.equal(
      shouldToastSessionError({
        previousLastError: null,
        currentLastError: "usage limit reached",
        lastActivityFailureDetail: null,
      }),
      true,
    );
  });

  it("does not toast when nothing changed", () => {
    assert.equal(
      shouldToastSessionError({
        previousLastError: "usage limit reached",
        currentLastError: "usage limit reached",
        lastActivityFailureDetail: null,
      }),
      false,
    );
  });

  it("does not toast when the error is cleared", () => {
    assert.equal(
      shouldToastSessionError({
        previousLastError: "usage limit reached",
        currentLastError: null,
        lastActivityFailureDetail: null,
      }),
      false,
    );
  });

  it("does not duplicate a turn-start failure activity detail", () => {
    assert.equal(
      shouldToastSessionError({
        previousLastError: null,
        currentLastError: "usage limit reached",
        lastActivityFailureDetail: "usage limit reached",
      }),
      false,
    );
  });

  it("toasts again when a different error replaces the previous one", () => {
    assert.equal(
      shouldToastSessionError({
        previousLastError: "network error",
        currentLastError: "usage limit reached",
        lastActivityFailureDetail: "usage limit reached",
      }),
      false,
    );
    assert.equal(
      shouldToastSessionError({
        previousLastError: "network error",
        currentLastError: "usage limit reached",
        lastActivityFailureDetail: null,
      }),
      true,
    );
  });
});
