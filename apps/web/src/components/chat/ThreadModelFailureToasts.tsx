"use client";

import { useEffect } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useThreadActivities, useThreadSession, useThreadStatus } from "~/state/entities";
import { usePrimarySettings } from "~/hooks/useSettings";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  activityFailureDetail,
  activityFailureTitle,
  findNewModelFailureActivities,
  shouldToastSessionError,
} from "./threadModelFailureToasts.logic";

interface ThreadFailureToastMemory {
  /** Activity ids already toasted (or seeded as pre-existing), per thread. */
  seenActivityIds: Set<string>;
  previousLastError: string | null;
  /** Detail of the last turn-start failure activity toasted, so the mirrored
   *  `session.lastError` does not produce a duplicate toast. */
  lastActivityFailureDetail: string | null;
  /** When the current session error was last toasted (cooldown re-notify). */
  lastSessionErrorToastAt: number | null;
  /** Whether the last observed status was "live" (streaming). */
  live: boolean;
}

// Module-level so a failure toasts exactly once even when the chat view
// unmounts (thread switch) and remounts while the thread still shows it.
const failureToastMemoryByThreadKey = new Map<string, ThreadFailureToastMemory>();

/**
 * Fires an error toast when the active thread's model run fails — for any
 * model role. Covers both surfaces the server reports a model failure on:
 * failure activities appended to the thread (`provider.turn.start.failed`,
 * `provider.text-generation.failed`) and a turn that failed mid-run
 * (`session.lastError`). Renders nothing.
 */
export function ThreadModelFailureToasts({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const status = useThreadStatus(threadRef);
  const activities = useThreadActivities(threadRef);
  const session = useThreadSession(threadRef);
  const notificationSettings = usePrimarySettings((settings) => settings.notificationSettings);

  useEffect(() => {
    if (threadRef === null) {
      return;
    }
    // The "model failures" toggle gates every toast this component fires;
    // memory is untouched while off so re-enabling re-baselines quietly.
    if (!notificationSettings.modelFailures) {
      return;
    }
    const threadKey = scopedThreadKey(threadRef);
    const lastError = session?.lastError ?? null;
    const isLive = status === "live";

    const memory = failureToastMemoryByThreadKey.get(threadKey);

    // First observation: everything already in the thread is the baseline.
    // Failures that are already visible in the timeline / error banner must
    // not toast.
    if (memory === undefined) {
      failureToastMemoryByThreadKey.set(threadKey, {
        seenActivityIds: new Set(activities.map((activity) => activity.id)),
        previousLastError: lastError,
        lastActivityFailureDetail: null,
        lastSessionErrorToastAt: null,
        live: isLive,
      });
      return;
    }

    // Cold open: the first live render can arrive before the initial snapshot
    // does, so the baseline above was seeded from an empty thread. Re-baseline
    // when the data first goes live so pre-existing failures from the snapshot
    // do not toast either. Reconnects keep their seen set so failures that
    // happened while the client was away still surface.
    if (!memory.live && isLive && memory.seenActivityIds.size === 0) {
      failureToastMemoryByThreadKey.set(threadKey, {
        ...memory,
        seenActivityIds: new Set(activities.map((activity) => activity.id)),
        previousLastError: lastError,
        lastActivityFailureDetail: null,
        live: true,
      });
      return;
    }

    for (const activity of findNewModelFailureActivities(activities, memory.seenActivityIds)) {
      memory.seenActivityIds.add(activity.id);
      const detail = activityFailureDetail(activity);
      memory.lastActivityFailureDetail = detail;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: activityFailureTitle(activity.kind),
          description: detail,
          data: { threadRef },
        }),
      );
    }

    if (
      shouldToastSessionError({
        previousLastError: memory.previousLastError,
        currentLastError: lastError,
        lastActivityFailureDetail: memory.lastActivityFailureDetail,
        // Cooldown re-notify is its own toggle; disabled means a persistent
        // error toasts only on its first occurrence.
        lastToastAtMs: notificationSettings.repeatedModelFailures
          ? memory.lastSessionErrorToastAt
          : null,
      })
    ) {
      memory.lastSessionErrorToastAt = Date.now();
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Run failed",
          description: lastError,
          data: { threadRef },
        }),
      );
    }
    memory.previousLastError = lastError;
    memory.live = isLive;
  }, [activities, notificationSettings, session, status, threadRef]);

  return null;
}
