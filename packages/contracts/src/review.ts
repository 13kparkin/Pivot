import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId, IsoDateTime, PositiveInt, ProjectId } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { PullRequestDiffSide } from "./pullRequest.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

// ---------------------------------------------------------------------------
// Local review diff preview (existing surface).
// ---------------------------------------------------------------------------

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

// ---------------------------------------------------------------------------
// Agent diff review runs (issue #42).
// ---------------------------------------------------------------------------

/**
 * Provider sessions that back a review run use a thread id namespaced with this
 * prefix, so `ProviderRuntimeIngestion` can tell a review run's events from a
 * real thread's and skip them (they are consumed by `ReviewReactor` instead).
 */
export const REVIEW_SESSION_THREAD_ID_PREFIX = "review-";

/**
 * A review run's identity, and the provider session thread id it runs under
 * (the two are the same value: `ThreadId.make(reviewId)`). Client-generated,
 * mirroring how clients generate thread ids.
 */
export const ReviewId = TrimmedNonEmptyString.pipe(Schema.brand("ReviewId"));
export type ReviewId = typeof ReviewId.Type;

/**
 * Which change a review run covers. `working-tree` is the uncommitted diff
 * (git diff HEAD + untracked); `branch-range` is committed-but-unpushed work
 * against `baseRef`; `pr` is an open pull request on a host.
 */
export const ReviewSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("working-tree") }),
  Schema.Struct({
    kind: Schema.Literal("branch-range"),
    baseRef: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("pr"),
    host: TrimmedNonEmptyString,
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
]);
export type ReviewSource = typeof ReviewSource.Type;

export const ReviewFindingSeverity = Schema.Literals(["blocking", "should-fix", "nit"]);
export type ReviewFindingSeverity = typeof ReviewFindingSeverity.Type;

/**
 * One actionable finding from a review run, anchored to a file and line of the
 * diff under review. `line` is null for a file-level finding. `side` matches
 * the existing `PullRequestDiffSide` so findings render through the same
 * annotation surface as host review threads.
 */
export const ReviewFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  file: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  side: PullRequestDiffSide,
  severity: ReviewFindingSeverity,
  message: TrimmedNonEmptyString,
  symbol: Schema.NullOr(TrimmedNonEmptyString),
});
export type ReviewFinding = typeof ReviewFinding.Type;

export const ReviewRunStatus = Schema.Literals(["running", "completed", "failed"]);
export type ReviewRunStatus = typeof ReviewRunStatus.Type;

/**
 * Read-model view of one review run: its source, its status, and the findings
 * produced so far. Findings stream in while the run is `running`.
 */
export const ReviewRun = Schema.Struct({
  id: ReviewId,
  source: ReviewSource,
  status: ReviewRunStatus,
  findings: Schema.Array(ReviewFinding),
  /**
   * The thread this review was started from, when it was. Absent for a review
   * started from the Pull Requests page. A review run is never a thread turn;
   * this only records provenance.
   */
  threadRef: Schema.NullOr(ScopedThreadRef),
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
  errorMessage: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type ReviewRun = typeof ReviewRun.Type;
