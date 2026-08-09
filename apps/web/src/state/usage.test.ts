import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getEnvironmentUsageLoadingState,
  isEnvironmentUsageSettling,
  resolveEnvironmentUsageScope,
  type EnvironmentUsageOption,
} from "./usageEnvironmentScope";

const environment = (
  environmentId: string,
  phase: EnvironmentConnectionPhase,
): EnvironmentUsageOption => ({
  environmentId: environmentId as EnvironmentId,
  label: environmentId,
  phase,
});

describe("usage environment scope", () => {
  it("keeps healthy and offline environments in all-environment coverage", () => {
    const options = [environment("healthy", "connected"), environment("down", "offline")];
    const scope = resolveEnvironmentUsageScope(options, null);

    expect(scope.environments).toEqual(options);
    expect(isEnvironmentUsageSettling(scope.environments[0]!.phase)).toBe(true);
    expect(isEnvironmentUsageSettling(scope.environments[1]!.phase)).toBe(false);
  });

  it("finishes with healthy totals when another environment is offline", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connected", summary: {}, error: null },
        { phase: "offline", summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("returns immediately when the only environment is offline", () => {
    expect(
      getEnvironmentUsageLoadingState([{ phase: "offline", summary: null, error: null }]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("keeps healthy totals visible while another environment reconnects", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connected", summary: {}, error: null },
        { phase: "reconnecting", summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: true });
  });

  it("shows connection transitions as settling but leaves idle entries terminal", () => {
    expect(isEnvironmentUsageSettling("available")).toBe(false);
    expect(isEnvironmentUsageSettling("connecting")).toBe(true);
    expect(isEnvironmentUsageSettling("reconnecting")).toBe(true);
    expect(isEnvironmentUsageSettling("connected")).toBe(true);
    expect(isEnvironmentUsageSettling("offline")).toBe(false);
    expect(isEnvironmentUsageSettling("error")).toBe(false);
  });

  it("keeps a selected offline environment terminal and isolated", () => {
    const scope = resolveEnvironmentUsageScope(
      [environment("healthy", "connected"), environment("down", "offline")],
      "down" as EnvironmentId,
    );

    expect(scope.selectedEnvironmentId).toBe("down");
    expect(scope.environments).toEqual([environment("down", "offline")]);
    expect(isEnvironmentUsageSettling(scope.environments[0]!.phase)).toBe(false);
  });

  it("falls back to all environments when the selection disappears", () => {
    const options = [environment("healthy", "connected")];
    const scope = resolveEnvironmentUsageScope(options, "removed" as EnvironmentId);

    expect(scope.selectedEnvironmentId).toBeNull();
    expect(scope.environments).toEqual(options);
  });
});
