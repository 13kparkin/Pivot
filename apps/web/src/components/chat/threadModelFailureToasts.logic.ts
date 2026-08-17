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
 * Minimum gap between toasts for the SAME session error string. Persistent
 * failures (quota exhaustion) repeat every turn; without a cooldown they would
 * toast once then be suppressed forever by the equality check below.
 */
export const SESSION_ERROR_REPEAT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Whether a session-level error (a turn that failed mid-run) deserves a new
 * toast: a new error string toasts immediately; the SAME error string
 * re-toasts only after {@link SESSION_ERROR_REPEAT_COOLDOWN_MS} has elapsed
 * since the last toast for it. It must never duplicate the detail of a
 * turn-start failure activity already toasted for the same thread (the server
 * mirrors the activity detail into `session.lastError`).
 */
export function shouldToastSessionError(input: {
  readonly previousLastError: string | null;
  readonly currentLastError: string | null;
  readonly lastActivityFailureDetail: string | null;
  /** When the same error was last toasted, or null if never toasted. */
  readonly lastToastAtMs?: number | null;
  readonly nowMs?: number;
}): boolean {
  if (input.currentLastError === null || input.currentLastError.length === 0) {
    return false;
  }
  if (input.currentLastError === input.lastActivityFailureDetail) {
    return false;
  }
  if (input.previousLastError !== input.currentLastError) {
    return true;
  }
  // Same error again: only re-toast after the cooldown, and only if it was
  // actually toasted before (an error already present at baseline stays quiet).
  const lastToastAtMs = input.lastToastAtMs ?? null;
  if (lastToastAtMs === null) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  return nowMs - lastToastAtMs >= SESSION_ERROR_REPEAT_COOLDOWN_MS;
}
