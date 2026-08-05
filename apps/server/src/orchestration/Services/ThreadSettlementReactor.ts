import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadSettlementReactorShape {
  /** Start the persisted inactivity and merged-PR settlement lifecycle. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when all automatic settlement work already queued is complete. */
  readonly drain: Effect.Effect<void>;
}

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  ThreadSettlementReactorShape
>()("t3/orchestration/Services/ThreadSettlementReactor") {}
