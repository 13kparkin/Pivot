import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationReviewRunStreamItem,
  ReviewId,
  ReviewRun,
} from "@t3tools/contracts";
import { createReviewRunsStore } from "@t3tools/client-runtime/state/review-runs";
import { createReviewCommandsAtoms } from "@t3tools/client-runtime/state/review-commands";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewRunsStore = createReviewRunsStore(connectionAtomRuntime);
export const reviewCommands = createReviewCommandsAtoms(connectionAtomRuntime);

// Stable atom for a null review id so `useReviewRun` keeps a constant hook
// count when `reviewId` flips null → set (the review-start tap).
const EMPTY_REVIEW_RUN_STREAM_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile:review:run-subscription:empty"),
);

/**
 * The latest ReviewRun for a review id, null when none is known yet.
 * Subscribes to `orchestration.subscribeReviewRun` so findings stream in live
 * while the run is `running` — the same store the web diff panel uses.
 */
export function useReviewRun(
  environmentId: EnvironmentId | null,
  reviewId: ReviewId | null,
): ReviewRun | null {
  const atom =
    reviewId === null || environmentId === null
      ? EMPTY_REVIEW_RUN_STREAM_ATOM
      : reviewRunsStore.subscribe({
          environmentId,
          input: { reviewId },
        });
  const result = useAtomValue(atom);
  const item = Option.getOrNull(
    AsyncResult.value(result),
  ) as OrchestrationReviewRunStreamItem | null;
  const run = item === null || item.kind !== "review-run-updated" ? null : item.review;
  return run;
}
