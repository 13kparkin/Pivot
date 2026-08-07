import type { UsageActivityCount, UsageActivitySummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Behavioral counters drawn from T3 Code's own projections.
 *
 * The agent session logs record tokens but know nothing about skills, plans,
 * subagent types or checkpoint diffs, so this half of the usage page can only
 * come from here. Counts are deliberately provider-shaped rather than merged:
 * Claude reports a named tool per call while Codex reports an item type, so the
 * two are labelled but never summed into a single "tool" figure.
 */

const TOP_N = 12;

const toCounts = (
  rows: ReadonlyArray<{ name: unknown; count: unknown }>,
): Array<UsageActivityCount> =>
  rows
    .flatMap((row) => {
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const count = typeof row.count === "number" ? Math.trunc(row.count) : 0;
      return name.length === 0 || count <= 0 ? [] : [{ name, count }];
    })
    .sort((a, b) => b.count - a.count);

const firstNumber = (rows: ReadonlyArray<Record<string, unknown>>, key: string): number => {
  const value = rows.at(0)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
};

/**
 * @param sinceIso inclusive lower bound on `created_at`, ISO 8601.
 */
export const readActivitySummary = (
  sinceIso: string,
): Effect.Effect<UsageActivitySummary, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Claude records a tool name; Codex records an item type. COALESCE keeps
    // both on one axis without pretending they are the same vocabulary.
    const tools = yield* sql<{ name: unknown; count: unknown }>`
      SELECT
        COALESCE(
          json_extract(payload_json, '$.data.toolName'),
          json_extract(payload_json, '$.itemType')
        ) AS name,
        COUNT(*) AS count
      FROM projection_thread_activities
      WHERE kind = 'tool.completed' AND created_at >= ${sinceIso}
      GROUP BY name
      ORDER BY count DESC
      LIMIT ${TOP_N}
    `;

    const skills = yield* sql<{ name: unknown; count: unknown }>`
      SELECT
        json_extract(payload_json, '$.data.input.skill') AS name,
        COUNT(*) AS count
      FROM projection_thread_activities
      WHERE kind = 'tool.completed'
        AND json_extract(payload_json, '$.data.toolName') = 'Skill'
        AND created_at >= ${sinceIso}
      GROUP BY name
      ORDER BY count DESC
      LIMIT ${TOP_N}
    `;

    const subagents = yield* sql<{ name: unknown; count: unknown }>`
      SELECT
        json_extract(payload_json, '$.data.input.subagent_type') AS name,
        COUNT(*) AS count
      FROM projection_thread_activities
      WHERE kind = 'tool.completed'
        AND json_extract(payload_json, '$.data.toolName') = 'Agent'
        AND created_at >= ${sinceIso}
      GROUP BY name
      ORDER BY count DESC
      LIMIT ${TOP_N}
    `;

    // Timestamps are stored as ISO-8601 UTC, so these buckets are UTC hours.
    // Keeping them UTC is what makes them safe to sum across environments in
    // different timezones; the UI labels the axis accordingly.
    const hourRows = yield* sql<{ hour: unknown; count: unknown }>`
      SELECT
        CAST(strftime('%H', requested_at) AS INTEGER) AS hour,
        COUNT(*) AS count
      FROM projection_turns
      WHERE requested_at >= ${sinceIso}
      GROUP BY hour
    `;

    const totals = yield* sql<Record<string, unknown>>`
      SELECT
        (SELECT COUNT(*) FROM projection_turns WHERE requested_at >= ${sinceIso}) AS totalTurns,
        (SELECT COUNT(*) FROM projection_threads WHERE created_at >= ${sinceIso} AND deleted_at IS NULL) AS totalThreads,
        (SELECT COUNT(*) FROM projection_thread_activities
          WHERE kind = 'tool.completed' AND created_at >= ${sinceIso}) AS toolCalls,
        (SELECT COUNT(*) FROM projection_thread_activities
          WHERE kind = 'tool.completed' AND created_at >= ${sinceIso}
            AND (
              json_extract(payload_json, '$.data.item.exitCode') NOT IN (0)
              -- Claude tool results carry no exit code; they flag failure here.
              OR json_extract(payload_json, '$.data.result.is_error') = 1
            )) AS toolFailures
    `;

    const churn = yield* sql<Record<string, unknown>>`
      SELECT
        SUM(json_extract(file.value, '$.additions')) AS linesAdded,
        SUM(json_extract(file.value, '$.deletions')) AS linesDeleted
      FROM projection_turns AS turn, json_each(turn.checkpoint_files_json) AS file
      WHERE turn.requested_at >= ${sinceIso}
    `;

    const turnsByHour = Array.from({ length: 24 }, () => 0);
    for (const row of hourRows) {
      const hour = typeof row.hour === "number" ? row.hour : Number.NaN;
      const count = typeof row.count === "number" ? Math.trunc(row.count) : 0;
      if (Number.isInteger(hour) && hour >= 0 && hour < 24 && count > 0) turnsByHour[hour] = count;
    }

    return {
      tools: toCounts(tools),
      skills: toCounts(skills),
      subagents: toCounts(subagents),
      turnsByHour,
      totalTurns: firstNumber(totals, "totalTurns"),
      totalThreads: firstNumber(totals, "totalThreads"),
      toolCalls: firstNumber(totals, "toolCalls"),
      toolFailures: firstNumber(totals, "toolFailures"),
      linesAdded: firstNumber(churn, "linesAdded"),
      linesDeleted: firstNumber(churn, "linesDeleted"),
    } satisfies UsageActivitySummary;
  }).pipe(
    // Usage reporting is read-only and non-critical: a malformed payload or a
    // schema drift should degrade the panel, never fail the request.
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read usage activity summary", { cause }).pipe(
        Effect.as({
          tools: [],
          skills: [],
          subagents: [],
          turnsByHour: Array.from({ length: 24 }, () => 0),
          totalTurns: 0,
          totalThreads: 0,
          toolCalls: 0,
          toolFailures: 0,
          linesAdded: 0,
          linesDeleted: 0,
        } satisfies UsageActivitySummary),
      ),
    ),
  );
