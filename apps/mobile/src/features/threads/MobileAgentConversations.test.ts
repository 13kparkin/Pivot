import { describe, expect, it } from "vite-plus/test";

import { formatSubagentDisplayLabel } from "@t3tools/client-runtime/state/subagentRuntime";

import { mobileAgentTreeIndent } from "./mobileAgentConversationLayout";

describe("mobileAgentTreeIndent", () => {
  it("keeps shallow hierarchy visible", () => {
    expect(mobileAgentTreeIndent(2)).toEqual({ indentation: 36, hiddenAncestors: 0 });
  });

  it("caps indentation without discarding deep ancestry", () => {
    expect(mobileAgentTreeIndent(7)).toEqual({ indentation: 54, hiddenAncestors: 4 });
  });
});

describe("mobile agent conversation identity", () => {
  it("uses the explicit OMP agent name when the title is an assignment", () => {
    expect(
      formatSubagentDisplayLabel({
        id: "BeaconAnalyst",
        title: "Complete assignment thoroughly: # Target Analyze development workflow...",
      }),
    ).toBe("BeaconAnalyst");
  });
});
