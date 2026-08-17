import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Activity kinds that mean "a model call failed" — the provider could not
 * start the agent run (`provider.turn.start.failed`) or a background model
 * call (thread title, rename) failed (`provider.text-generation.failed`).
 * Control-plane failures (interrupt/session-stop/respond failures, stale
 * approval responses) are deliberately excluded: they are not model errors
 * and toasting them would be noise.
 */
export const MODEL_FAILURE_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "provider.turn.start.failed",
  "provider.text-generation.failed",
]);

export function activityFailureDetail(activity: OrchestrationThreadActivity): string {
  const payload = activity.payload;
  if (typeof payload === "object" && payload !== null) {
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail.trim().length > 0) {
      return detail;
    }
  }
  return activity.summary;
}

export function activityFailureTitle(kind: string): string {
  switch (kind) {
    case "provider.text-generation.failed":
      return "Model call failed";
    default:
      return "Run failed to start";
  }
}

/**
 * The failure activities that have not been seen yet. The chat view passes
 * the ids it has already toasted (or seeded as pre-existing), so a new turn
 * failure produces exactly one toast.
 */
export function findNewModelFailureActivities(
  activities: readonly OrchestrationThreadActivity[],
  seenActivityIds: ReadonlySet<string>,
): OrchestrationThreadActivity[] {
  return activities.filter(
    (activity) =>
      MODEL_FAILURE_ACTIVITY_KINDS.has(activity.kind) && !seenActivityIds.has(activity.id),
  );
}

/**
 * Whether a session-level error (a turn that failed mid-run) deserves a new
 * toast: it must be a new error string, and it must not duplicate the detail
 * of a turn-start failure activity already toasted for the same thread (the
 * server mirrors the activity detail into `session.lastError`).
 */
export function shouldToastSessionError(input: {
  readonly previousLastError: string | null;
  readonly currentLastError: string | null;
  readonly lastActivityFailureDetail: string | null;
}): boolean {
  if (input.currentLastError === null || input.currentLastError.length === 0) {
    return false;
  }
  if (input.previousLastError === input.currentLastError) {
    return false;
  }
  if (input.currentLastError === input.lastActivityFailureDetail) {
    return false;
  }
  return true;
}
