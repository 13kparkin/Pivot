import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ReviewRun } from "@t3tools/contracts";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionReviewRunInput,
  ProjectionReviewRunRepository,
  type ProjectionReviewRunRepositoryShape,
} from "../Services/ProjectionReviewRuns.ts";

const ProjectionReviewRunDbRowSchema = Schema.Struct({
  id: Schema.String,
  environment_id: Schema.String,
  status: Schema.String,
  run_json: Schema.String,
  updated_at: Schema.String,
});
type ProjectionReviewRunDbRow = typeof ProjectionReviewRunDbRowSchema.Type;

const decodeReviewRunRow = (row: ProjectionReviewRunDbRow): Option.Option<ReviewRun> =>
  Schema.decodeUnknownOption(ReviewRun)(JSON.parse(row.run_json));

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionReviewRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getReviewRunRows = SqlSchema.findAll({
    Request: GetProjectionReviewRunInput,
    Result: ProjectionReviewRunDbRowSchema,
    execute: ({ reviewId }) =>
      sql`
        SELECT id, environment_id, status, run_json, updated_at
        FROM projection_review_runs
        WHERE id = ${reviewId}
        LIMIT 1
      `,
  });

  const upsertReviewRun = SqlSchema.void({
    Request: ReviewRun,
    execute: (run) =>
      sql`
        INSERT INTO projection_review_runs (id, environment_id, status, run_json, updated_at)
        VALUES (${run.id}, ${run.environmentId}, ${run.status}, ${JSON.stringify(run)}, ${run.updatedAt})
        ON CONFLICT (id)
        DO UPDATE SET
          status = excluded.status,
          run_json = excluded.run_json,
          updated_at = excluded.updated_at
      `,
  });

  const getById: ProjectionReviewRunRepositoryShape["getById"] = (input) =>
    getReviewRunRows(input).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) {
          return Option.none<ReviewRun>();
        }
        return decodeReviewRunRow(row);
      }),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionReviewRunRepository.getById:query",
          "ProjectionReviewRunRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: ProjectionReviewRunRepositoryShape["upsert"] = (run) =>
    upsertReviewRun(run).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionReviewRunRepository.upsert:query")),
    );

  return ProjectionReviewRunRepository.of({ getById, upsert });
});

export const ProjectionReviewRunRepositoryLive = Layer.effect(
  ProjectionReviewRunRepository,
  makeProjectionReviewRunRepository,
);
