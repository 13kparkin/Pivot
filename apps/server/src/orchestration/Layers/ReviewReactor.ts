import {
  CommandId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type OrchestrationEvent,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ReviewId,
  type ReviewRun,
  type RuntimeMode,
  ReviewStartedPayload,
  REVIEW_SESSION_THREAD_ID_PREFIX,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Schema from "effect/Schema";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ReviewReactor, type ReviewReactorShape } from "../Services/ReviewReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { reviewPersona } from "../../review/reviewPersona.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { forkParked } from "../../serverActivation.ts";

class ReviewReactorError extends Schema.TaggedErrorClass<ReviewReactorError>()(
  "ReviewReactorError",
  { message: Schema.String },
) {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isReviewSessionThreadId = (threadId: string): boolean =>
  threadId.startsWith(REVIEW_SESSION_THREAD_ID_PREFIX);

interface ResolvedWorkspace {
  readonly workspacePath: string;
  /** The repository the workspace lives under; used to remove a PR worktree. */
  readonly repoCwd: string;
  readonly removeWorktree: boolean;
}

type ReactorInput =
  | { readonly source: "domain"; readonly event: OrchestrationEvent }
  | { readonly source: "runtime"; readonly event: ProviderRuntimeEvent };

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const receiptBus = yield* RuntimeReceiptBus;
  const gitManager = yield* GitManager.GitManager;
  const gitWorkflowService = yield* GitWorkflowService.GitWorkflowService;

  // Workspaces of running review sessions, keyed by the review session thread
  // id, so a terminal run can remove its PR worktree.
  const reviewWorkspaces = yield* Ref.make(new Map<string, ResolvedWorkspace>());

  const requireSome = <A>(
    value: Option.Option<A>,
    message: string,
  ): Effect.Effect<A, ReviewReactorError> =>
    Option.isSome(value)
      ? Effect.succeed(value.value)
      : Effect.fail(new ReviewReactorError({ message }));

  const readReviewRun = (
    reviewId: ReviewId,
  ): Effect.Effect<ReviewRun | null, ProjectionRepositoryError> =>
    projectionSnapshotQuery
      .getCommandReadModel()
      .pipe(
        Effect.map((model) => (model.reviewRuns ?? []).find((run) => run.id === reviewId) ?? null),
      );

  const dispatchReviewFindingAdded = Effect.fn("dispatchReviewFindingAdded")(function* (
    reviewId: ReviewId,
    finding: ReviewRun["findings"][number],
  ) {
    const commandId = yield* serverCommandId("review-finding");
    yield* orchestrationEngine
      .dispatch({
        type: "review.finding.added",
        commandId,
        reviewId,
        finding,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.catch(() => Effect.void));
  });

  const dispatchReviewCompleted = Effect.fn("dispatchReviewCompleted")(function* (
    reviewId: ReviewId,
    completedAt: string,
  ) {
    const commandId = yield* serverCommandId("review-completed");
    yield* orchestrationEngine
      .dispatch({
        type: "review.completed",
        commandId,
        reviewId,
        completedAt,
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* receiptBus.publish({
      type: "review.completed",
      reviewId,
      createdAt: completedAt,
    });
  });

  const dispatchReviewFailed = Effect.fn("dispatchReviewFailed")(function* (
    reviewId: ReviewId,
    errorMessage: string | null,
    completedAt: string,
  ) {
    const commandId = yield* serverCommandId("review-failed");
    yield* orchestrationEngine
      .dispatch({
        type: "review.failed",
        commandId,
        reviewId,
        errorMessage,
        completedAt,
      })
      .pipe(Effect.catch(() => Effect.void));
    yield* receiptBus.publish({
      type: "review.failed",
      reviewId,
      errorMessage,
      createdAt: completedAt,
    });
  });

  const finalizeReview = Effect.fn("finalizeReview")(function* (sessionThreadId: ThreadId) {
    yield* providerService
      .stopSession({ threadId: sessionThreadId })
      .pipe(Effect.catch(() => Effect.void));
    const workspace = (yield* Ref.get(reviewWorkspaces)).get(sessionThreadId);
    if (workspace?.removeWorktree === true) {
      yield* gitWorkflowService
        .removeWorktree({ cwd: workspace.repoCwd, path: workspace.workspacePath })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("ReviewReactor failed to remove review worktree", {
              workspacePath: workspace.workspacePath,
              cause: error,
            }),
          ),
        );
    }
    yield* Ref.update(reviewWorkspaces, (map) => {
      const next = new Map(map);
      next.delete(sessionThreadId);
      return next;
    });
  });

  const runReviewInner = Effect.fn("runReview")(function* (payload: ReviewStartedPayload) {
    const reviewId = payload.reviewId;
    const run = yield* readReviewRun(reviewId);
    if (run === null) {
      return;
    }

    let workspace: ResolvedWorkspace;
    let instanceId: ProviderInstanceId;
    let modelSelection: ModelSelection | undefined;
    let runtimeMode: RuntimeMode;

    if (run.source.kind === "pr") {
      const project = yield* requireSome(
        yield* projectionSnapshotQuery.getProjectShellById(run.projectId as never),
        "Review project not found.",
      );
      const prepared = yield* gitManager.preparePullRequestThread({
        cwd: project.workspaceRoot,
        reference: `#${run.source.number}`,
        mode: "worktree",
      });
      workspace =
        prepared.worktreePath === null
          ? {
              workspacePath: project.workspaceRoot,
              repoCwd: project.workspaceRoot,
              removeWorktree: false,
            }
          : {
              workspacePath: prepared.worktreePath,
              repoCwd: project.workspaceRoot,
              removeWorktree: true,
            };
      instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("omp"));
      modelSelection = undefined;
      runtimeMode = "full-access";
    } else {
      const threadId = run.threadRef?.threadId;
      if (threadId === undefined) {
        return yield* Effect.fail(
          new ReviewReactorError({ message: "A local review run has no host thread." }),
        );
      }
      const thread = yield* requireSome(
        yield* projectionSnapshotQuery.getThreadShellById(threadId),
        `Review host thread '${threadId}' not found.`,
      );
      const project = yield* requireSome(
        yield* projectionSnapshotQuery.getProjectShellById(thread.projectId),
        `Review project '${thread.projectId}' not found.`,
      );
      const workspacePath = resolveThreadWorkspaceCwd({
        thread: { projectId: thread.projectId, worktreePath: thread.worktreePath },
        projects: [{ id: project.id, workspaceRoot: project.workspaceRoot }],
      });
      if (workspacePath === undefined) {
        return yield* Effect.fail(
          new ReviewReactorError({ message: "Review host thread has no workspace." }),
        );
      }
      workspace = {
        workspacePath,
        repoCwd: project.workspaceRoot,
        removeWorktree: false,
      };
      instanceId = thread.modelSelection.instanceId;
      modelSelection = thread.modelSelection;
      runtimeMode = thread.runtimeMode;
    }

    const sessionThreadId = ThreadId.make(reviewId);
    yield* Ref.update(reviewWorkspaces, (map) => {
      const next = new Map(map);
      next.set(sessionThreadId, workspace);
      return next;
    });

    yield* providerService.startSession(sessionThreadId, {
      threadId: sessionThreadId,
      provider: ProviderDriverKind.make("omp"),
      providerInstanceId: instanceId,
      cwd: workspace.workspacePath,
      runtimeMode,
      ...(modelSelection !== undefined ? { modelSelection } : {}),
    });
    yield* providerService.sendTurn({
      threadId: sessionThreadId,
      input: reviewPersona({ workspacePath: workspace.workspacePath, source: run.source }),
      interactionMode: "review",
      ...(modelSelection !== undefined ? { modelSelection } : {}),
    });
  });

  const runReview = (payload: ReviewStartedPayload) =>
    runReviewInner(payload).pipe(
      Effect.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return nowIso.pipe(
          Effect.flatMap((occurredAt) =>
            dispatchReviewFailed(payload.reviewId, message, occurredAt),
          ),
          Effect.tap(() => finalizeReview(ThreadId.make(payload.reviewId))),
        );
      }),
    );

  const processDomainEvent = Effect.fn("processReviewDomainEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type === "review.started") {
      yield* runReview(event.payload);
    }
  });

  const processRuntimeEvent = Effect.fn("processReviewRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (!isReviewSessionThreadId(event.threadId)) {
      return;
    }
    const reviewId = event.threadId as unknown as ReviewId;
    const sessionThreadId = ThreadId.make(event.threadId);
    if (event.type === "review.finding") {
      yield* dispatchReviewFindingAdded(reviewId, event.payload);
      return;
    }
    if (event.type === "turn.completed") {
      if (event.payload.state === "failed") {
        yield* dispatchReviewFailed(reviewId, event.payload.errorMessage ?? null, event.createdAt);
      } else {
        yield* dispatchReviewCompleted(reviewId, event.createdAt);
      }
      yield* finalizeReview(sessionThreadId);
      return;
    }
    if (event.type === "turn.aborted") {
      yield* dispatchReviewFailed(reviewId, "Review turn was interrupted.", event.createdAt);
      yield* finalizeReview(sessionThreadId);
    }
  });

  const processInput = (input: ReactorInput) =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catch((error) =>
        Effect.logWarning("review reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          error,
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ReviewReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "review.started") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          !isReviewSessionThreadId(event.threadId) ||
          (event.type !== "review.finding" &&
            event.type !== "turn.completed" &&
            event.type !== "turn.aborted")
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ReviewReactorShape;
});

export const ReviewReactorLive = Layer.effect(ReviewReactor, make);
