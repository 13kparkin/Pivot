import { useAtomValue } from "@effect/atom-react";
import { createReviewRunsStore } from "@t3tools/client-runtime/state/review-runs";
import { createReviewCommandsAtoms } from "@t3tools/client-runtime/state/review-commands";
import type { EnvironmentId, ReviewId, ReviewRun } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewRunsStore = createReviewRunsStore(connectionAtomRuntime);
export const reviewCommands = createReviewCommandsAtoms(connectionAtomRuntime);

// ---------------------------------------------------------------------------
// Advisory dismissal. Findings never block anything; dismissing one is a
// client-local preference keyed by (reviewId, findingId), so a dismissed
// finding stays out of the way across re-renders without touching the server.
// ---------------------------------------------------------------------------

type DismissalKey = string;

const EMPTY_DISMISSED: ReadonlySet<string> = new Set();
let dismissed = new Set<DismissalKey>();
const dismissalListeners = new Set<() => void>();

function dismissalKey(reviewId: ReviewId, findingId: string): DismissalKey {
  return `${reviewId}:${findingId}`;
}

function emitDismissals() {
  for (const listener of dismissalListeners) {
    listener();
  }
}

export function dismissFinding(reviewId: ReviewId, findingId: string) {
  dismissed = new Set(dismissed).add(dismissalKey(reviewId, findingId));
  emitDismissals();
}

export function isFindingDismissed(reviewId: ReviewId, findingId: string): boolean {
  return dismissed.has(dismissalKey(reviewId, findingId));
}

export function useDismissedFindingIds(reviewId: ReviewId | null): ReadonlySet<string> {
  if (reviewId === null) {
    return EMPTY_DISMISSED;
  }
  return useSyncExternalStore(
    (onStoreChange) => {
      dismissalListeners.add(onStoreChange);
      return () => {
        dismissalListeners.delete(onStoreChange);
      };
    },
    () => {
      const prefix = `${reviewId}:`;
      const ids = new Set<string>();
      for (const key of dismissed) {
        if (key.startsWith(prefix)) {
          ids.add(key.slice(prefix.length));
        }
      }
      return ids;
    },
  );
}

/**
 * The latest ReviewRun for a review id, null when none is known yet. Subscribes
 * to `orchestration.subscribeReviewRun` so findings stream in live while the
 * run is `running`.
 */
export function useReviewRun(
  environmentId: EnvironmentId | null,
  reviewId: ReviewId | null,
): ReviewRun | null {
  if (reviewId === null || environmentId === null) {
    return null;
  }
  const atom = reviewRunsStore.subscribe({
    environmentId,
    input: { reviewId },
  });
  const result = useAtomValue(atom);
  const item = Option.getOrNull(AsyncResult.value(result)) as
    | import("@t3tools/contracts").OrchestrationReviewRunStreamItem
    | null;
  if (item === null || item.kind !== "review-run-updated") {
    return null;
  }
  return item.review;
}
