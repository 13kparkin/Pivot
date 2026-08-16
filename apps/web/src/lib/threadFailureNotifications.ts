import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { isStalePendingRequestFailureDetail } from "../session-logic";

/**
 * Error-toned activity kinds that are not real failures, so they must never
 * produce a failure toast:
 * - `tool.denied` is an intentional user denial of a tool request.
 * - `advisor.comment` is review feedback (already tinted destructively for
 *   blockers in the timeline), not a failure of the agent's work.
 */
const NON_FAILURE_ERROR_KINDS: Record<string, true> = {
  "tool.denied": true,
  "advisor.comment": true,
};

const PENDING_RESPONSE_FAILURE_KINDS: Record<string, true> = {
  "provider.approval.respond.failed": true,
  "provider.user-input.respond.failed": true,
};

/** Reads the human-readable failure body from an activity's payload. */
export function failureActivityDetail(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail.length > 0) {
    return record.detail;
  }
  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message;
  }
  return undefined;
}

/**
 * True when an error-toned activity represents a genuine failure worth
 * surfacing to the user (naming, runtime, checkpoint, provider, setup-script,
 * ...). Bookkeeping failures for pending requests the server has already
 * forgotten (stale/unknown pending approval or user-input) stay silent: they
 * are cleanup artifacts after a restart, not actionable failures.
 */
export function isThreadFailureActivityToastable(activity: OrchestrationThreadActivity): boolean {
  if (activity.tone !== "error") {
    return false;
  }
  if (NON_FAILURE_ERROR_KINDS[activity.kind] === true) {
    return false;
  }
  if (PENDING_RESPONSE_FAILURE_KINDS[activity.kind] === true) {
    return !isStalePendingRequestFailureDetail(failureActivityDetail(activity));
  }
  return true;
}

/**
 * Accounts for a thread's activity list and returns the failure activities
 * that are genuinely new and should be toasted.
 *
 * History never toasts: hydration and reconnect replays arrive while the
 * detail stream is not yet `live`, so those ids are recorded silently. Only
 * ids first observed while `live` (fresh failures streaming in mid-turn) are
 * returned, and each id toasts at most once per session.
 *
 * Edge: on servers without resume-completion markers the initial snapshot is
 * applied directly as live, so a failure already on the thread toasts once on
 * open. The user is looking at that thread and the row renders in the
 * timeline, so this only adds a redundant toast.
 */
export function observeThreadFailureActivities(
  threadKey: string,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  live: boolean,
  seenByThread: Map<string, Set<string>>,
): ReadonlyArray<OrchestrationThreadActivity> {
  let seen = seenByThread.get(threadKey);
  if (seen === undefined) {
    seen = new Set<string>();
    seenByThread.set(threadKey, seen);
  }
  const toToast: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
    if (!isThreadFailureActivityToastable(activity)) {
      continue;
    }
    if (seen.has(activity.id)) {
      continue;
    }
    seen.add(activity.id);
    if (live) {
      toToast.push(activity);
    }
  }
  return toToast;
}
