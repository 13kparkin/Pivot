import {
  SUBAGENT_REUSE_AFTER_IDLE_PROMPT,
  SUBAGENT_REUSE_AFTER_IDLE_RESUME_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

/**
 * Regression for subagent reuse across a session reap.
 *
 * Adapters track spawned subagents in a process-local map, so the reaper
 * releasing the session runtime wipes every identity it knows about. Without
 * rehydrating them from the projection, the returning agent thread is
 * unrecognised on the next turn and gets registered as a brand new subagent —
 * the user sees a duplicate appear and the original frozen forever.
 *
 * Not registered yet. The recorded transcript does contain a real reuse, but
 * replaying it leaves the second run running forever so the scenario never
 * reaches thread idle, and that is unrelated to the reuse routing here — it
 * reproduces with those changes reverted. An advance_clock step to cross the
 * 30-minute idle timeout (which is what would exercise rehydration rather than
 * plain reuse) fails the same way, so it is left out until the hang is
 * understood.
 */
export function subagentReuseAfterIdleInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SUBAGENT_REUSE_AFTER_IDLE_PROMPT },
      { type: "message", text: SUBAGENT_REUSE_AFTER_IDLE_RESUME_PROMPT },
    ],
  };
}
