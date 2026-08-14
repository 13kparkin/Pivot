import { describe, expect, it } from "@effect/vitest";

import { mapOmpUsageReport, parseOmpUsageJson } from "./ompPlanUsage.ts";

describe("parseOmpUsageJson", () => {
  it("maps openai-codex plan used/remaining", () => {
    const providers = parseOmpUsageJson(
      JSON.stringify({
        generatedAt: 1,
        reports: [
          {
            provider: "openai-codex",
            limits: [
              {
                id: "openai-codex:primary",
                label: "7 days",
                window: { id: "7d", label: "7 days", resetsAt: 1787210412000 },
                amount: {
                  used: 41,
                  limit: 100,
                  remaining: 59,
                  usedFraction: 0.41,
                  remainingFraction: 0.59,
                  unit: "percent",
                },
                status: "ok",
              },
            ],
            metadata: { planType: "plus" },
          },
        ],
      }),
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.provider).toBe("openai-codex");
    expect(providers[0]?.planType).toBe("plus");
    expect(providers[0]?.limits[0]).toMatchObject({
      id: "openai-codex:primary",
      windowLabel: "7 days",
      used: 41,
      remaining: 59,
      usedFraction: 0.41,
      remainingFraction: 0.59,
      unit: "percent",
      resetsAtMs: 1787210412000,
    });
  });

  it("returns empty for malformed stdout", () => {
    expect(parseOmpUsageJson("not-json")).toEqual([]);
    expect(mapOmpUsageReport(null)).toBeNull();
  });
});
