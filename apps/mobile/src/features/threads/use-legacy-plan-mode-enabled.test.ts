import { describe, expect, it } from "@effect/vitest";

import { resolveLegacyPlanModeEnabled } from "./legacy-plan-mode";

describe("resolveLegacyPlanModeEnabled", () => {
  it("stays off until the explicit legacy preference has loaded", () => {
    expect(resolveLegacyPlanModeEnabled({ loaded: false, preference: true })).toBe(false);
    expect(resolveLegacyPlanModeEnabled({ loaded: true, preference: undefined })).toBe(false);
    expect(resolveLegacyPlanModeEnabled({ loaded: true, preference: false })).toBe(false);
  });

  it("enables plan mode only for an explicit loaded opt-in", () => {
    expect(resolveLegacyPlanModeEnabled({ loaded: true, preference: true })).toBe(true);
  });
});
