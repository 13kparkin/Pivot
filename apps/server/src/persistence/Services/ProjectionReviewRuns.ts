import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ReviewId, ReviewRun } from "@t3tools/contracts";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const GetProjectionReviewRunInput = Schema.Struct({
  reviewId: ReviewId,
});
export type GetProjectionReviewRunInput = typeof GetProjectionReviewRunInput.Type;

/**
 * Projection repository for review runs. Each run is stored whole (source,
 * findings, status) under one row keyed by review id; the pipeline upserts it
 * as findings land and the run reaches a terminal state. `ProjectionSnapshotQuery`
 * reads the same table back into `OrchestrationReadModel.reviewRuns`.
 */
export interface ProjectionReviewRunRepositoryShape {
  readonly getById: (
    input: GetProjectionReviewRunInput,
  ) => Effect.Effect<Option.Option<ReviewRun>, ProjectionRepositoryError>;
  readonly upsert: (run: ReviewRun) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionReviewRunRepository extends Context.Service<
  ProjectionReviewRunRepository,
  ProjectionReviewRunRepositoryShape
>()("pivot-cli/persistence/Services/ProjectionReviewRuns/ProjectionReviewRunRepository") {}
