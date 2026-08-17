import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ReviewId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ReviewRun,
  type ReviewSource,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ENV = EnvironmentId.make("env-1");
const PROJECT = ProjectId.make("project-1");
const THREAD_REF: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-1") };

function makeReadModel(
  input: {
    readonly thread?: OrchestrationThread | null;
    readonly reviews?: ReadonlyArray<ReviewRun>;
  } = {},
): OrchestrationReadModel {
  const thread = input.thread ?? {
    id: THREAD_REF.threadId,
    projectId: PROJECT,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  return {
    snapshotSequence: 0,
    projects: [],
    threads: thread ? [thread] : [],
    ...(input.reviews !== undefined ? { reviewRuns: input.reviews } : {}),
    updatedAt: NOW,
  };
}

function runningReview(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: ReviewId.make("review-1"),
    source: { kind: "working-tree" },
    status: "running",
    findings: [],
    threadRef: THREAD_REF,
    environmentId: ENV,
    projectId: PROJECT,
    errorMessage: null,
    createdAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function startCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "review.start",
    commandId: CommandId.make("cmd-start-1"),
    reviewId: ReviewId.make("review-1"),
    source: { kind: "working-tree" } satisfies ReviewSource,
    threadRef: THREAD_REF,
    environmentId: ENV,
    projectId: PROJECT,
    createdAt: NOW,
    ...overrides,
  } as const;
}

/** Assert the command is rejected with an invariant error whose detail contains `fragment`. */
function expectRejected(fragment: string) {
  return (error: { _tag: string; detail: string }): Effect.Effect<void> => {
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
    expect(error.detail).toContain(fragment);
    return Effect.void;
  };
}

it.layer(NodeServices.layer)("review.start decider", (it) => {
  it.effect("starts a working-tree review from a thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: startCommand(),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      const first = events[0];
      expect(first?.type).toBe("review.started");
      if (first?.type !== "review.started") return;
      expect(first.payload.reviewId).toBe("review-1");
      expect(first.payload.source).toEqual({ kind: "working-tree" });
      expect(first.payload.threadRef).toEqual(THREAD_REF);
      expect(first.payload.environmentId).toBe(ENV);
    }),
  );

  it.effect("starts a pr review from the pull requests page (no thread)", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: startCommand({
          reviewId: ReviewId.make("review-pr"),
          source: { kind: "pr", host: "github.com", repository: "owner/repo", number: 42 },
          threadRef: null,
        }),
        readModel: makeReadModel({ thread: null }),
      });
      const events = Array.isArray(event) ? event : [event];
      const first = events[0];
      expect(first?.type).toBe("review.started");
      if (first?.type !== "review.started") return;
      expect(first.payload.threadRef).toBeNull();
      expect(first.payload.source).toEqual({
        kind: "pr",
        host: "github.com",
        repository: "owner/repo",
        number: 42,
      });
    }),
  );

  it.effect("starts a branch-range review with a base ref", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: startCommand({
          reviewId: ReviewId.make("review-branch"),
          source: { kind: "branch-range", baseRef: "main" },
        }),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      const first = events[0];
      expect(first?.type).toBe("review.started");
      if (first?.type !== "review.started") return;
      expect(first.payload.source).toEqual({ kind: "branch-range", baseRef: "main" });
    }),
  );

  it.effect("rejects a start for a missing host thread", () =>
    decideOrchestrationCommand({
      command: startCommand({
        threadRef: { environmentId: ENV, threadId: ThreadId.make("nope") },
      }),
      readModel: makeReadModel(),
    }).pipe(
      Effect.catchTag("OrchestrationCommandInvariantError", expectRejected("does not exist")),
    ),
  );

  it.effect("rejects a start while a review is running on the same host thread", () =>
    decideOrchestrationCommand({
      command: startCommand({ reviewId: ReviewId.make("review-2") }),
      readModel: makeReadModel({ reviews: [runningReview()] }),
    }).pipe(Effect.catchTag("OrchestrationCommandInvariantError", expectRejected("running"))),
  );

  it.effect("rejects a start while a pr review is running for the same pull request", () =>
    decideOrchestrationCommand({
      command: startCommand({
        reviewId: ReviewId.make("review-2"),
        source: { kind: "pr", host: "github.com", repository: "owner/repo", number: 42 },
        threadRef: null,
      }),
      readModel: makeReadModel({
        thread: null,
        reviews: [
          runningReview({
            id: ReviewId.make("review-1"),
            source: { kind: "pr", host: "github.com", repository: "owner/repo", number: 42 },
            threadRef: null,
          }),
        ],
      }),
    }).pipe(Effect.catchTag("OrchestrationCommandInvariantError", expectRejected("running"))),
  );

  it.effect("allows a second review when the first has completed", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: startCommand({ reviewId: ReviewId.make("review-2") }),
        readModel: makeReadModel({
          reviews: [runningReview({ status: "completed", completedAt: NOW })],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("review.started");
    }),
  );
});

it.layer(NodeServices.layer)("review finding/completion decider", (it) => {
  const finding = {
    id: "finding-1",
    file: "src/a.ts",
    line: 12,
    side: "right",
    severity: "should-fix",
    message: "Inline a single-use helper.",
    symbol: "doThing",
  } as const;

  it.effect("records a finding on a running review", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "review.finding.added",
          commandId: CommandId.make("cmd-f-1"),
          reviewId: ReviewId.make("review-1"),
          finding,
          createdAt: NOW,
        },
        readModel: makeReadModel({ reviews: [runningReview()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("review.finding.added");
    }),
  );

  it.effect("rejects a finding when the review is not running", () =>
    decideOrchestrationCommand({
      command: {
        type: "review.finding.added",
        commandId: CommandId.make("cmd-f-1"),
        reviewId: ReviewId.make("review-1"),
        finding,
        createdAt: NOW,
      },
      readModel: makeReadModel({
        reviews: [runningReview({ status: "completed", completedAt: NOW })],
      }),
    }).pipe(Effect.catchTag("OrchestrationCommandInvariantError", expectRejected("not running"))),
  );

  it.effect("completes a running review", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "review.completed",
          commandId: CommandId.make("cmd-c-1"),
          reviewId: ReviewId.make("review-1"),
          completedAt: NOW,
        },
        readModel: makeReadModel({ reviews: [runningReview()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("review.completed");
    }),
  );

  it.effect("fails a running review with an error message", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "review.failed",
          commandId: CommandId.make("cmd-x-1"),
          reviewId: ReviewId.make("review-1"),
          errorMessage: "Findings JSON was malformed",
          completedAt: NOW,
        },
        readModel: makeReadModel({ reviews: [runningReview()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      const first = events[0];
      expect(first?.type).toBe("review.failed");
      if (first?.type !== "review.failed") return;
      expect(first.payload.errorMessage).toBe("Findings JSON was malformed");
    }),
  );

  it.effect("requests a fix for a finding on a completed review", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "review.finding.fix",
          commandId: CommandId.make("cmd-fix-1"),
          reviewId: ReviewId.make("review-1"),
          findingId: "finding-1",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          reviews: [runningReview({ status: "completed", completedAt: NOW, findings: [finding] })],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      const first = events[0];
      expect(first?.type).toBe("review.finding.fix.requested");
      if (first?.type !== "review.finding.fix.requested") return;
      expect(first.payload.findingId).toBe("finding-1");
    }),
  );

  it.effect("rejects a fix for a finding the review does not have", () =>
    decideOrchestrationCommand({
      command: {
        type: "review.finding.fix",
        commandId: CommandId.make("cmd-fix-1"),
        reviewId: ReviewId.make("review-1"),
        findingId: "finding-missing",
        createdAt: NOW,
      },
      readModel: makeReadModel({
        reviews: [runningReview({ status: "completed", completedAt: NOW, findings: [finding] })],
      }),
    }).pipe(Effect.catchTag("OrchestrationCommandInvariantError", expectRejected("finding"))),
  );

  it.effect("updates a finding on a completed review", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "review.finding.updated",
          commandId: CommandId.make("cmd-fu-1"),
          reviewId: ReviewId.make("review-1"),
          finding: { ...finding, fixState: "fixing" },
          createdAt: NOW,
        },
        readModel: makeReadModel({
          reviews: [runningReview({ status: "completed", completedAt: NOW, findings: [finding] })],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      const first = events[0];
      expect(first?.type).toBe("review.finding.updated");
      if (first?.type !== "review.finding.updated") return;
      expect(first.payload.finding.fixState).toBe("fixing");
    }),
  );
});
