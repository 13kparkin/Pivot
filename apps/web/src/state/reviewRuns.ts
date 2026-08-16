import { useAtomValue } from "@effect/atom-react";
import { createReviewRunsStore } from "@t3tools/client-runtime/state/review-runs";
import { createReviewCommandsAtoms } from "@t3tools/client-runtime/state/review-commands";
import type { EnvironmentId, ModelSelection, ReviewId, ReviewRun } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { modelRolesFromSettingsEntries } from "../components/capabilities/CapabilitiesModelsRolesPanel.logic";
import { useMemo } from "react";
import { usePrimarySettings } from "../hooks/useSettings";
import { primaryServerProvidersAtom } from "./server";
import { resolveAppModelSelectionState } from "../modelSelection";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { getDisplayModelName } from "../components/chat/providerIconUtils";

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
