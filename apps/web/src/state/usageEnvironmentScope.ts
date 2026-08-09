import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export interface EnvironmentUsageOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: EnvironmentConnectionPhase;
}

/** Connection phases where a usage answer may still arrive without user action. */
export function isEnvironmentUsageSettling(phase: EnvironmentConnectionPhase): boolean {
  return phase === "connecting" || phase === "reconnecting" || phase === "connected";
}

export function resolveEnvironmentUsageScope(
  options: readonly EnvironmentUsageOption[],
  selectedEnvironmentId: EnvironmentId | null,
): {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly environments: readonly EnvironmentUsageOption[];
} {
  const effectiveSelection =
    selectedEnvironmentId !== null &&
    options.some((environment) => environment.environmentId === selectedEnvironmentId)
      ? selectedEnvironmentId
      : null;
  return {
    selectedEnvironmentId: effectiveSelection,
    environments:
      effectiveSelection === null
        ? options
        : options.filter((environment) => environment.environmentId === effectiveSelection),
  };
}

interface EnvironmentUsageLoadingEntry {
  readonly phase: EnvironmentConnectionPhase;
  readonly summary: unknown | null;
  readonly error: string | null;
}

export function isEnvironmentUsageStillReporting(
  environment: EnvironmentUsageLoadingEntry,
): boolean {
  return (
    isEnvironmentUsageSettling(environment.phase) &&
    environment.summary === null &&
    environment.error === null
  );
}

export function getEnvironmentUsageLoadingState(
  environments: readonly EnvironmentUsageLoadingEntry[],
): { readonly isPending: boolean; readonly isPartial: boolean } {
  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(isEnvironmentUsageStillReporting).length;

  return {
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
  };
}
