import {
  SubagentActivationId,
  type NodeId,
  type OrchestrationV2SubagentRole,
} from "@t3tools/contracts";

export const defaultSubagentRole = (name = "general-purpose"): OrchestrationV2SubagentRole => ({
  name,
  source: "app_default",
});

export const subagentActivationId = (subagentId: NodeId, ordinal: number) =>
  SubagentActivationId.make(`${subagentId}:activation:${ordinal}`);
