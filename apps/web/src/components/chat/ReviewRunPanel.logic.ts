import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewFinding } from "@t3tools/contracts";

import { isFindingPlaceable } from "../../lib/reviewFindings";

/**
 * Pure view of a completed review run's coverage: which rendered diff files
 * the run's `filesReviewed` ledger covered, which it missed, and which
 * findings the current diff can no longer place (stale anchors).
 */
export interface ReviewCoverageView {
  readonly covered: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly outdatedFindings: ReadonlyArray<ReviewFinding>;
}

/**
 * Derive the run panel's coverage checklist and stale-finding set from the
 * run's ledger and the rendered diff. `covered` is the ledger intersected
 * with the rendered files (a ledger may name files no longer in the diff);
 * `missing` is the rendered files the ledger skipped; `outdated` is findings
 * with a line the diff-comment mapper would reject — file-level findings
 * (line null) are not stale, they are deliberately unanchored.
 */
export function deriveReviewRunCoverage(input: {
  readonly filesReviewed: ReadonlyArray<string> | undefined;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly files: ReadonlyArray<{ readonly fileDiff: FileDiffMetadata; readonly filePath: string }>;
}): ReviewCoverageView {
  const reviewed = new Set(input.filesReviewed ?? []);
  const rendered = new Set(input.files.map((file) => file.filePath));
  const covered = (input.filesReviewed ?? []).filter((path) => rendered.has(path));
  const missing = input.files.map((file) => file.filePath).filter((path) => !reviewed.has(path));
  const outdatedFindings = input.findings.filter(
    (finding) => finding.line !== null && !isFindingPlaceable(finding, input.files),
  );
  return { covered, missing, outdatedFindings };
}
