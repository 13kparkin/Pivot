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

describe("mobile usage environment scope", () => {
  it("distinguishes connection progress from terminal states", () => {
    expect(isEnvironmentUsageSettling("available")).toBe(false);
    expect(isEnvironmentUsageSettling("connecting")).toBe(true);
    expect(isEnvironmentUsageSettling("reconnecting")).toBe(true);
    expect(isEnvironmentUsageSettling("offline")).toBe(false);
    expect(isEnvironmentUsageSettling("error")).toBe(false);
  });

  it("does not let an offline environment hold healthy totals open", () => {
    expect(
      getEnvironmentUsageLoadingState([
        { phase: "connected", summary: {}, error: null },
        { phase: "offline", summary: null, error: null },
      ]),
    ).toEqual({ isPending: false, isPartial: false });
  });

  it("isolates a selected environment and falls back when it disappears", () => {
    const options = [environment("healthy", "connected"), environment("down", "offline")];

    expect(resolveEnvironmentUsageScope(options, "down" as EnvironmentId).environments).toEqual([
      options[1],
    ]);
    expect(
      resolveEnvironmentUsageScope(options.slice(0, 1), "down" as EnvironmentId)
        .selectedEnvironmentId,
    ).toBeNull();
  });
});
