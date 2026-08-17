import type { UsagePlanLimit, UsagePlanProvider } from "@t3tools/contracts";

/**
 * Per-limit state the monitor persists between polls. `resetsAtMs` is tracked
 * so a limit that resets and re-enters a warning state toasts again instead of
 * being suppressed by the status-equality check.
 */
export interface PlanLimitToastState {
  readonly status: string;
  readonly resetsAtMs: number | undefined;
}

export type PlanLimitToastStates = ReadonlyMap<string, PlanLimitToastState>;

export interface PlanLimitToast {
  readonly key: string;
  readonly provider: string;
  readonly label: string;
  readonly status: "warning" | "exhausted";
}

export function planLimitKey(
  provider: string,
  limit: Pick<UsagePlanLimit, "id" | "windowLabel">,
): string {
  return `${provider}:${limit.windowLabel}:${limit.id}`;
}

/**
 * Which plan limits newly entered — or re-entered after a reset — a warning or
 * exhausted state. Returns the toasts to fire plus the next state map for the
 * caller to persist. Recovery back to "ok" is deliberately quiet.
 */
export function findPlanLimitTransitions(
  previous: PlanLimitToastStates,
  providers: readonly UsagePlanProvider[],
): { readonly toasts: readonly PlanLimitToast[]; readonly next: PlanLimitToastStates } {
  const next = new Map<string, PlanLimitToastState>();
  const toasts: PlanLimitToast[] = [];

  for (const provider of providers) {
    for (const limit of provider.limits) {
      const key = planLimitKey(provider.provider, limit);
      const status = limit.status;
      next.set(key, { status, resetsAtMs: limit.resetsAtMs });

      if (status !== "warning" && status !== "exhausted") {
        continue;
      }
      const prior = previous.get(key);
      // A reset is only detectable when both polls report a reset time and
      // it changed; an absent value means "same window, unknown boundary".
      const reset =
        prior !== undefined &&
        prior.resetsAtMs !== undefined &&
        limit.resetsAtMs !== undefined &&
        prior.resetsAtMs !== limit.resetsAtMs;
      if (prior !== undefined && prior.status === status && !reset) {
        continue;
      }
      toasts.push({
        key,
        provider: provider.provider,
        label: limit.label,
        status,
      });
    }
  }

  return { toasts, next };
}
