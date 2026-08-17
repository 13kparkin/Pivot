import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import { startReview, type StartReviewInput } from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type { StartReviewInput } from "../operations/commands.ts";

/**
 * Client command atoms for review runs. `start` dispatches `review.start`,
 * serialized per environment + review id so a re-click cannot double-start the
 * same run.
 */
export function createReviewCommandsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { reviewId: string } }) =>
      JSON.stringify([environmentId, input.reviewId]),
  };
  return {
    start: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:review:start",
      execute: (input: StartReviewInput) => startReview(input),
      scheduler,
      concurrency,
    }),
  };
}
