import type {
  PullRequestReviewThread,
  ReviewFinding,
  ReviewFindingSeverity,
} from "@t3tools/contracts";

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
