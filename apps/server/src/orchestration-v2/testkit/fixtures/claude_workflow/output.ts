import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_WORKFLOW_PROMPT } from "./input.ts";

export function assertClaudeWorkflowOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_WORKFLOW_PROMPT]);

  const coordinator = projection.subagents.find((subagent) => subagent.kind === "workflow");
  assert.isDefined(coordinator, "the workflow must reach the projection as a coordinator");
  assert.deepEqual(coordinator?.role, { name: "workflow-coordinator", source: "app_default" });
  assert.deepEqual(coordinator?.workflow?.phases, [
    { index: 0, title: "Research" },
    { index: 1, title: "Implement" },
  ]);

  const members = projection.subagents
    .filter((subagent) => subagent.kind === "workflow_agent")
    .toSorted(
      (left, right) =>
        (left.workflowMembership?.agentIndex ?? 0) - (right.workflowMembership?.agentIndex ?? 0),
    );
  assert.lengthOf(members, 2, "both workflow members must reach the projection");
  assert.deepEqual(
    members.map((member) => [
      member.title,
      member.status,
      member.workflowMembership?.phaseIndex,
      member.model,
      member.usage?.totalTokens,
    ]),
    [
      ["Researcher", "completed", 0, "claude-sonnet-4-6", 400],
      ["Implementer", "running", 1, "claude-opus-4-1", 500],
    ],
  );
  // Membership must point at the coordinator that actually reached the
  // projection, not at an id the adapter invented independently.
  assert.deepEqual(
    [...new Set(members.map((member) => member.workflowMembership?.workflowSubagentId))],
    [coordinator?.id],
  );

  // The panel groups by these three fields, so pin the values it reads rather
  // than only the ones the coordinator carries. The derivation itself is
  // covered in client-runtime; the schema is what joins the two sides, so what
  // matters here is that the server emits a shape that groups cleanly:
  // every member claims a declared phase, and no member is left ungrouped.
  const declaredPhases = new Set((coordinator?.workflow?.phases ?? []).map((phase) => phase.index));
  assert.deepEqual(
    members.map((member) => declaredPhases.has(member.workflowMembership?.phaseIndex ?? -1)),
    [true, true],
  );
  assert.lengthOf(
    projection.subagents.filter(
      (subagent) => subagent.kind === "workflow_agent" && subagent.workflowMembership === null,
    ),
    0,
    "a member without membership would render outside its workflow",
  );
  // The coordinator's usage already covers its members, so the panel subtracts
  // theirs from it. That only stays non-negative if the provider's totals are
  // carried through unmodified.
  const memberTotal = members.reduce(
    (total, member) => total + (member.usage?.totalTokens ?? 0),
    0,
  );
  assert.isAtLeast(coordinator?.usage?.totalTokens ?? 0, memberTotal);

  const assistantTexts = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(assistantTexts, [
    "Starting the two-phase workflow.",
    "claude workflow fixture complete",
  ]);
}
