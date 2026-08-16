import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ReviewReactorShape - Service API for the review-run reactor.
 */
export interface ReviewReactorShape {
  /**
   * Start the review reactor. The returned effect must be run in a scope so
   * all worker fibers can be finalized on shutdown. Consumes orchestration
   * `review.*` domain events and the provider-runtime events of review
   * sessions (see `REVIEW_SESSION_THREAD_ID_PREFIX`).
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ReviewReactor - Service tag for review-run workers.
 */
export class ReviewReactor extends Context.Service<ReviewReactor, ReviewReactorShape>()(
  "pivot-cli/orchestration/Services/ReviewReactor",
) {}
