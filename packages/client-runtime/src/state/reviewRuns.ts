import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Review runs come from the orchestration read model as a live subscription
 * (`orchestration.subscribeReviewRun`), not a query: findings stream in while
 * the run is `running`, so the store reduces the stream to the latest
 * `ReviewRun` per review id. The web layer reads the resulting atom per review
 * it shows and maps findings to the annotation surface.
 */
export function createReviewRunsStore<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const subscribe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:review-runs:subscribe",
    tag: ORCHESTRATION_WS_METHODS.subscribeReviewRun,
    // The stream carries `synchronized` (no data) and `review-run-updated`
    // (a whole ReviewRun) frames; keep only the data frames so the atom holds
    // the latest run.
    transform: (stream) =>
      stream.pipe(
        Stream.filterMap((item) =>
          item.kind === "review-run-updated" ? Option.some(item.review) : Option.none(),
        ),
      ),
  });

  return { subscribe };
}
