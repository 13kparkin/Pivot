import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Review runs come from the orchestration read model as a live subscription
 * (`orchestration.subscribeReviewRun`), not a query: findings stream in while
 * the run is `running`. The atom holds the latest stream item; consumers read
 * the `review` out of `review-run-updated` frames (a `synchronized` frame means
 * "no data yet").
 */
export function createReviewRunsStore<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const subscribe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:review-runs:subscribe",
    tag: ORCHESTRATION_WS_METHODS.subscribeReviewRun,
  });

  return { subscribe };
}
