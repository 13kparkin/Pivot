import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Usage reporting reads the session logs the coding agents already write to
 * disk (`~/.claude/projects`, `~/.codex/sessions`) rather than T3 Code's own
 * event log. The event log only sees threads T3 Code drove and carries no
 * cache-write counts, which makes exact cost impossible to derive from it.
 *
 * Every snapshot is scoped to one environment. The client fans out across
 * connected environments and merges, so each server only reports its own host.
 */

export const UsageProvider = Schema.Literals(["claude", "codex"]);
export type UsageProvider = typeof UsageProvider.Type;

/** An ISO date (YYYY-MM-DD) in the host's local timezone. */
export const UsageDate = TrimmedNonEmptyString;
export type UsageDate = typeof UsageDate.Type;

/**
 * Token counts are disjoint buckets: `inputTokens` excludes anything served
 * from cache, so a total is the sum of every field.
 */
export const UsageTokenTotals = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  /** Reasoning tokens are a subset of `outputTokens`, reported by Codex only. */
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageModelTotals = Schema.Struct({
  model: TrimmedNonEmptyString,
  provider: UsageProvider,
  tokens: UsageTokenTotals,
  costUsd: Schema.Number,
  messages: NonNegativeInt,
  /**
   * False when no pricing entry matched the model slug. The row still carries
   * token counts, but its cost is 0 and must be shown as unknown rather than free.
   */
  pricingKnown: Schema.Boolean,
});
export type UsageModelTotals = typeof UsageModelTotals.Type;

export const UsageProviderDailyTotals = Schema.Struct({
  provider: UsageProvider,
  costUsd: Schema.Number,
  totalTokens: NonNegativeInt,
});
export type UsageProviderDailyTotals = typeof UsageProviderDailyTotals.Type;

export const UsageDailyTotals = Schema.Struct({
  date: UsageDate,
  costUsd: Schema.Number,
  totalTokens: NonNegativeInt,
  byProvider: Schema.Array(UsageProviderDailyTotals),
});
export type UsageDailyTotals = typeof UsageDailyTotals.Type;

export const UsageProjectTotals = Schema.Struct({
  /** Directory basename of the session's cwd; "unknown" when the log omits it. */
  project: TrimmedNonEmptyString,
  costUsd: Schema.Number,
  totalTokens: NonNegativeInt,
  messages: NonNegativeInt,
});
export type UsageProjectTotals = typeof UsageProjectTotals.Type;

/**
 * Codex writes its remaining quota into every session log. Claude does not,
 * so this list is usually Codex-only.
 */
export const UsageRateLimitWindow = Schema.Struct({
  provider: UsageProvider,
  planType: Schema.optional(TrimmedNonEmptyString),
  usedPercent: Schema.Number,
  windowMinutes: NonNegativeInt,
  resetsAt: Schema.optional(Schema.String),
  observedAt: Schema.String,
});
export type UsageRateLimitWindow = typeof UsageRateLimitWindow.Type;

/** Per-provider scan bookkeeping, so the UI can distinguish "zero" from "not installed". */
export const UsageSourceReport = Schema.Struct({
  provider: UsageProvider,
  /** False when the provider's log directory is absent on this host. */
  available: Schema.Boolean,
  filesScanned: NonNegativeInt,
  recordsRead: NonNegativeInt,
  /**
   * Records dropped because another file already billed them. Resumed and
   * forked sessions duplicate heavily; ignoring this overcounts by ~2.7x.
   */
  duplicatesSkipped: NonNegativeInt,
  modelsWithoutPricing: Schema.Array(TrimmedNonEmptyString),
});
export type UsageSourceReport = typeof UsageSourceReport.Type;

export const UsageActivityCount = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
});
export type UsageActivityCount = typeof UsageActivityCount.Type;

/**
 * Behavioral counters from T3 Code's own event log. The agent session files
 * carry no notion of skills, plans or diffs, so this half stays local.
 */
export const UsageActivitySummary = Schema.Struct({
  tools: Schema.Array(UsageActivityCount),
  skills: Schema.Array(UsageActivityCount),
  subagents: Schema.Array(UsageActivityCount),
  /** 24 buckets, index 0 is midnight local time. */
  turnsByHour: Schema.Array(NonNegativeInt),
  totalTurns: NonNegativeInt,
  totalThreads: NonNegativeInt,
  toolCalls: NonNegativeInt,
  toolFailures: NonNegativeInt,
  linesAdded: NonNegativeInt,
  linesDeleted: NonNegativeInt,
});
export type UsageActivitySummary = typeof UsageActivitySummary.Type;

export const EnvironmentUsageSnapshot = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  generatedAt: Schema.String,
  /** Oldest and newest day with usage, absent when nothing was found. */
  firstDate: Schema.optional(UsageDate),
  lastDate: Schema.optional(UsageDate),
  costUsd: Schema.Number,
  tokens: UsageTokenTotals,
  messages: NonNegativeInt,
  sessions: NonNegativeInt,
  models: Schema.Array(UsageModelTotals),
  daily: Schema.Array(UsageDailyTotals),
  projects: Schema.Array(UsageProjectTotals),
  rateLimits: Schema.Array(UsageRateLimitWindow),
  sources: Schema.Array(UsageSourceReport),
  activity: UsageActivitySummary,
});
export type EnvironmentUsageSnapshot = typeof EnvironmentUsageSnapshot.Type;

/**
 * Clamps how far back the reader walks. Defaults to 30 days when omitted.
 * Declared as loose fields rather than a Struct because GET payloads encode
 * through the query string.
 */
export const EnvironmentUsageQuery = {
  sinceDate: Schema.optional(UsageDate),
};
