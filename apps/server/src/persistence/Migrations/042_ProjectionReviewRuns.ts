import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_review_runs (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      status TEXT NOT NULL,
      run_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_review_runs_environment_status
      ON projection_review_runs (environment_id, status)
  `;
});
