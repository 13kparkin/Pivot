import { useAtomValue } from "@effect/atom-react";
import { createReviewRunsStore } from "@t3tools/client-runtime/state/review-runs";
import { createReviewCommandsAtoms } from "@t3tools/client-runtime/state/review-commands";
import type { EnvironmentId, ModelSelection, ReviewId, ReviewRun } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { modelRolesFromSettingsEntries } from "../components/capabilities/CapabilitiesModelsRolesPanel.logic";
import { usePrimarySettings } from "../hooks/useSettings";
import { primaryServerProvidersAtom } from "./server";
import { resolveAppModelSelectionState } from "../modelSelection";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { getDisplayModelName } from "../components/chat/providerIconUtils";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

const EMPTY_CAPABILITIES_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web:review:capabilities-snapshot:empty"),
);
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

// The snapshot returned by `useSyncExternalStore` must be referentially stable
// until the underlying store changes: `dismissed` is replaced wholesale on
// dismiss, so caching keyed on (dismissed reference, reviewId) yields a stable
// set between mutations. A fresh Set per call would never compare equal and
// React would force-re-render forever ("Maximum update depth exceeded").
let dismissedSnapshotCache: {
  readonly dismissedRef: typeof dismissed;
  readonly reviewId: ReviewId;
  readonly ids: ReadonlySet<string>;
} | null = null;

export function useDismissedFindingIds(reviewId: ReviewId | null): ReadonlySet<string> {
  // Hooks are unconditional: `reviewId` flips null → set when a review starts,
  // and a conditional hook would shift every hook after it in the calling
  // component (React's per-fiber hook array no longer aligns → TypeError).
  return useSyncExternalStore(
    (onStoreChange) => {
      if (reviewId === null) {
        return () => {};
      }
      dismissalListeners.add(onStoreChange);
      return () => {
        dismissalListeners.delete(onStoreChange);
      };
    },
    () => {
      if (reviewId === null) {
        return EMPTY_DISMISSED;
      }
      const cache = dismissedSnapshotCache;
      if (cache !== null && cache.dismissedRef === dismissed && cache.reviewId === reviewId) {
        return cache.ids;
      }
      const prefix = `${reviewId}:`;
      const ids = new Set<string>();
      for (const key of dismissed) {
        if (key.startsWith(prefix)) {
          ids.add(key.slice(prefix.length));
        }
      }
      dismissedSnapshotCache = { dismissedRef: dismissed, reviewId, ids };
      return ids;
    },
  );
}

// Review ids are client-generated and unique per run (`ReviewId.make(randomUUID())`),
// so one module-level set is enough to fire the failure toast exactly once,
// even if the panel unmounts and remounts while the run is already failed.
const reviewFailureToastShown = new Set<ReviewId>();

// Stable atom for a null review id so `useReviewRun` keeps a constant hook
// count when `reviewId` flips null → set (the review-start click). A
// conditional hook there shifts every hook after it in the calling component
// and crashes React's `areHookInputsEqual` with an undefined deps array.
const EMPTY_REVIEW_RUN_STREAM_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web:review:run-subscription:empty"),
);

/**
 * The latest ReviewRun for a review id, null when none is known yet. Subscribes
 * to `orchestration.subscribeReviewRun` so findings stream in live while the
 * run is `running`. A run that ends in `failed` (a model usage-limit or any
 * other provider error) surfaces as an error toast, not just the inline
 * "Review failed" strip in the diff panel.
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
  const item = Option.getOrNull(AsyncResult.value(result)) as
    | import("@t3tools/contracts").OrchestrationReviewRunStreamItem
    | null;
  const run = item === null || item.kind !== "review-run-updated" ? null : item.review;

  useEffect(() => {
    if (
      run === null ||
      reviewId === null ||
      run.status !== "failed" ||
      reviewFailureToastShown.has(reviewId)
    ) {
      return;
    }
    reviewFailureToastShown.add(reviewId);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Review failed",
        description: run.errorMessage ?? "The review could not be completed.",
      }),
    );
  }, [reviewId, run]);

  return run;
}

/**
 * Whether a dedicated `review` model role is configured for this environment.
 * Returns true when the snapshot has not loaded yet, so callers do not nag
 * before we know.
 */
export function useReviewModelConfigured(environmentId: EnvironmentId | null): boolean {
  const snapshotAtom =
    environmentId === null
      ? EMPTY_CAPABILITIES_SNAPSHOT_ATOM
      : serverEnvironment.capabilitiesSnapshot({ environmentId, input: {} });
  const result = useAtomValue(snapshotAtom);
  const snapshot = Option.getOrNull(AsyncResult.value(result))?.snapshot ?? null;
  return useMemo(() => {
    if (snapshot === null) {
      return true;
    }
    const roles = modelRolesFromSettingsEntries(snapshot.settings.entries);
    return roles.review !== undefined;
  }, [snapshot]);
}

/**
 * The display label of the model a review falls back to when no `review` role
 * is configured. When a thread model selection is provided (the thread entry
 * point), that selection is named; otherwise the app's default model. Falls
 * back to the raw slug when no option resolves.
 */
export function useReviewFallbackModelLabel(
  modelSelection: ModelSelection | null | undefined,
): string | null {
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(() => {
    const entries = deriveProviderInstanceEntries(providers);
    if (modelSelection?.model) {
      const entry = entries.find((candidate) => candidate.instanceId === modelSelection.instanceId);
      const model = entry?.models.find((candidate) => candidate.slug === modelSelection.model);
      if (model) {
        return getDisplayModelName(model);
      }
      return modelSelection.model;
    }
    const selection = resolveAppModelSelectionState(settings, providers);
    const defaultEntry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
    const defaultModel = defaultEntry?.models.find(
      (candidate) => candidate.slug === selection.model,
    );
    if (defaultModel) {
      return getDisplayModelName(defaultModel);
    }
    return selection.model || null;
  }, [modelSelection, providers, settings]);
}
