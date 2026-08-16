import { type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  failureActivityDetail,
  observeThreadFailureActivities,
} from "../lib/threadFailureNotifications";
import { useThreadActivities, useThreadStatus } from "../state/entities";

/**
 * Per-session memory of accounted failure activities, keyed by thread. Lives
 * at module scope so switching threads (or remounting the chat view) never
 * re-toasts a failure that already surfaced. Cleared on page reload, which is
 * correct: first observation of a thread re-seeds with its current activities.
 */
const seenFailureActivitiesByThread = new Map<string, Set<string>>();

/**
 * Surfaces genuine failures that happen while a thread is working (auto
 * naming, runtime errors, checkpoint capture/revert, provider failures,
 * setup-script launch, ...) as a top-right error toast, the same channel the
 * rest of the app uses for action failures.
 *
 * Only the routed thread's live detail stream is watched: background threads
 * have no live detail subscription in the web app, and forcing one would
 * multiply renderer-heap and server load.
 */
export function useThreadFailureToasts(ref: ScopedThreadRef | null): void {
  const activities = useThreadActivities(ref);
  const status = useThreadStatus(ref);

  useEffect(() => {
    if (ref === null) {
      return;
    }
    const newFailures = observeThreadFailureActivities(
      scopedThreadKey(ref),
      activities,
      status === "live",
      seenFailureActivitiesByThread,
    );
    for (const activity of newFailures) {
      const description = failureActivityDetail(activity);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: activity.summary,
          ...(description !== undefined ? { description } : {}),
        }),
      );
    }
  }, [activities, ref, status]);
}
