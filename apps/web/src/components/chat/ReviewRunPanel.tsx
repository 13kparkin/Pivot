"use client";

import type { EnvironmentId, ReviewFindingSeverity, ReviewId } from "@t3tools/contracts";
import { CheckIcon, LoaderIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";

import { dismissFinding, useDismissedFindingIds, useReviewRun } from "../../state/reviewRuns";
import { reviewSeverityLabel } from "../../lib/reviewFindings";

const SEVERITY_CLASS: Record<ReviewFindingSeverity, string> = {
  blocking: "text-red-500",
  "should-fix": "text-amber-500",
  nit: "text-muted-foreground",
};

/**
 * The review run's live status in the thread diff view: a spinner while it
 * runs (with a running finding count), the findings once it completes, or an
 * error when it fails. Renders nothing while idle (no review started).
 */
export function ReviewRunPanel({
  environmentId,
  reviewId,
}: {
  environmentId: EnvironmentId | null;
  reviewId: ReviewId | null;
}) {
  const run = useReviewRun(environmentId, reviewId);
  const dismissed = useDismissedFindingIds(reviewId);

  if (run === null) {
    return null;
  }

  if (run.status === "running") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="font-medium text-foreground">Reviewing changes…</span>
        {run.findings.length > 0 ? (
          <span className="text-muted-foreground">
            {run.findings.length} {run.findings.length === 1 ? "finding" : "findings"} so far
          </span>
        ) : null}
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-500" />
        <span className="font-medium text-foreground">Review failed</span>
        {run.errorMessage ? (
          <span className="min-w-0 truncate text-muted-foreground">{run.errorMessage}</span>
        ) : null}
      </div>
    );
  }

  const visibleFindings = run.findings.filter((finding) => !dismissed.has(finding.id));

  if (visibleFindings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
        <span className="font-medium text-foreground">
          {run.findings.length > 0
            ? "All findings dismissed."
            : "No issues found — this review is clean."}
        </span>
      </div>
    );
  }

  return (
    <div className="flex max-h-72 flex-col overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>Review findings</span>
        <span>{visibleFindings.length} total</span>
      </div>
      <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-2">
        {visibleFindings.map((finding) => (
          <div
            key={finding.id}
            className="rounded-md border border-border/60 bg-background px-3 py-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span
                  className={`text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_CLASS[finding.severity]}`}
                >
                  {reviewSeverityLabel(finding.severity)}
                </span>
                <span className="ml-2 font-mono text-[11px] text-muted-foreground/70">
                  {finding.file}
                  {finding.line !== null ? `:${finding.line}` : ""}
                </span>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Dismiss finding in ${finding.file}`}
                onClick={() => dismissFinding(run.id, finding.id)}
              >
                <Trash2Icon className="size-3" />
              </button>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">{finding.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
