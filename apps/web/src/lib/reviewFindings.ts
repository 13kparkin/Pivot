import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type {
  PullRequestReviewThread,
  ReviewFinding,
  ReviewFindingSeverity,
} from "@t3tools/contracts";

import { buildDiffReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";

export function reviewSeverityLabel(severity: ReviewFindingSeverity): string {
  switch (severity) {
    case "blocking":
      return "Blocking";
    case "should-fix":
      return "Should fix";
    case "nit":
      return "Nit";
  }
}

/** The comment body the annotation renders: a severity badge plus the message. */
export function reviewFindingBody(finding: ReviewFinding): string {
  const header = `**${reviewSeverityLabel(finding.severity)}** ${finding.message}`;
  return finding.symbol ? `${header}\n\n\`${finding.symbol}\`` : header;
}

function findingLineRange(finding: ReviewFinding): SelectedLineRange | null {
  if (finding.line === null) {
    return null;
  }
  const side = finding.side === "left" ? "deletions" : "additions";
  return { start: finding.line, end: finding.line, side, endSide: side };
}

/**
 * Convert review findings into inline diff comments for the code view, the
 * GitHub-style placement: one comment bubble anchored to the finding's
 * (file, line). A finding is skipped when it has no line, names a file not in
 * the rendered diff, or points at a line no rendered hunk contains — those
 * stay visible in the run's findings list instead.
 */
export function reviewFindingsToDiffComments(input: {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly files: ReadonlyArray<{
    readonly fileDiff: FileDiffMetadata;
    readonly filePath: string;
  }>;
  readonly sectionId: string;
  readonly sectionTitle: string;
}): ReadonlyArray<ReviewCommentContext> {
  const comments: ReviewCommentContext[] = [];
  for (const finding of input.findings) {
    const range = findingLineRange(finding);
    if (range === null) {
      continue;
    }
    const file = input.files.find((candidate) => candidate.filePath === finding.file);
    if (file === undefined) {
      continue;
    }
    const comment = buildDiffReviewComment({
      id: finding.id,
      sectionId: input.sectionId,
      sectionTitle: input.sectionTitle,
      filePath: finding.file,
      fileDiff: file.fileDiff,
      range,
      text: reviewFindingBody(finding),
    });
    if (comment !== null) {
      comments.push(comment);
    }
  }
  return comments;
}

/**
 * Map an agent `ReviewFinding` to the `PullRequestReviewThread` shape the
 * existing diff-annotation surface renders, so findings appear as inline
 * review comments with the same "Fix in a thread" hand-off as host threads.
 * `commentCreatedAt` is the review run's createdAt (findings carry no timestamp
 * of their own).
 */
export function reviewFindingToReviewThread(
  finding: ReviewFinding,
  commentCreatedAt: string,
): PullRequestReviewThread {
  return {
    id: finding.id,
    path: finding.file,
    line: finding.line,
    side: finding.side,
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: finding.id,
        author: null,
        body: reviewFindingBody(finding),
        createdAt: commentCreatedAt,
        url: null,
      },
    ],
  };
}
