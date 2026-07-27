import { describe, expect, it } from "vite-plus/test";
import { NodeId } from "@t3tools/contracts";

import { defaultSubagentRole, subagentActivationId } from "./SubagentObservability.ts";

describe("subagent observability", () => {
  it("marks a fallback role as app-provided so provider roles stay distinguishable", () => {
    expect(defaultSubagentRole()).toEqual({ name: "general-purpose", source: "app_default" });
    expect(defaultSubagentRole("workflow-worker")).toEqual({
      name: "workflow-worker",
      source: "app_default",
    });
  });

  it("derives activation ids that are stable and unique per ordinal", () => {
    const subagentId = NodeId.make("node:provider:codex:native-item:call_abc");
    expect(subagentActivationId(subagentId, 1)).toBe(`${subagentId}:activation:1`);
    // Stable derivation means a replayed activation updates its own row rather
    // than inserting a duplicate.
    expect(subagentActivationId(subagentId, 2)).toBe(subagentActivationId(subagentId, 2));
    expect(subagentActivationId(subagentId, 1)).not.toBe(subagentActivationId(subagentId, 2));
  });
});
