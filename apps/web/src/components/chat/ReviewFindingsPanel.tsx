"use client";

import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewFindingSeverity, ReviewId } from "@t3tools/contracts";
import { CheckIcon, LoaderIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";

import {
  dismissFinding,
  reviewCommands,
  useDismissedFindingIds,
  useReviewRun,
} from "../../state/reviewRuns";
import { isFindingPlaceable, reviewSeverityLabel } from "../../lib/reviewFindings";
import { useAtomCommand } from "../../state/use-atom-command";

const SEVERITY_CLASS: Record<ReviewFindingSeverity, string> = {
  blocking: "text-red-500",
  "should-fix": "text-amber-500",
  nit: "text-muted-foreground",
};

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 720;
const HEIGHT_STORAGE_KEY = "review-findings-height";

function readInitialHeight(): number {
  const stored = Number(localStorage.getItem(HEIGHT_STORAGE_KEY));
  if (Number.isFinite(stored) && stored >= MIN_HEIGHT && stored <= MAX_HEIGHT) {
    return stored;
  }
  return 220;
}

/**
 * The review's findings as a height-resizable section above the diff: a
 * header ("Review findings", verdict, count, Fix all with AI), one row per
 * finding with a per-finding "Fix with AI" action (a fix subagent edits the
 * workspace), and a drag handle on the bottom edge. Unplaceable findings keep
 * their Outdated badge; file-level findings stay unbadged.
 */
export function ReviewFindingsPanel({
  environmentId,
  reviewId,
  files,
}: {
  environmentId: EnvironmentId | null;
  reviewId: ReviewId | null;
  files: ReadonlyArray<{ readonly fileDiff: FileDiffMetadata; readonly filePath: string }>;
}) {
  const run = useReviewRun(environmentId, reviewId);
  const dismissed = useDismissedFindingIds(reviewId);
  const [height, setHeight] = useState(readInitialHeight);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const fixFinding = useAtomCommand(reviewCommands.fix, { reportFailure: false });

  useEffect(() => {
    localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
  }, [height]);

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: event.clientY, startHeight: height };
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null) {
        return;
      }
      const next = Math.min(
        MAX_HEIGHT,
        Math.max(MIN_HEIGHT, drag.startHeight + (event.clientY - drag.startY)),
      );
      setHeight(next);
    };
    const onPointerUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  if (run === null || run.status !== "completed") {
    return null;
  }

  const visibleFindings = run.findings.filter((finding) => !dismissed.has(finding.id));
  const anyFixing = run.findings.some((finding) => finding.fixState === "fixing");
  const fixableFindings = run.findings.filter((finding) => finding.fixState !== "fixed");

  const fixAll = () => {
    if (environmentId === null) {
      return;
    }
    for (const finding of fixableFindings) {
      if (finding.fixState !== "fixing") {
        void fixFinding({
          environmentId,
          input: { reviewId: run.id, findingId: finding.id },
        });
      }
    }
  };

  const fixOne = (findingId: string) => {
    if (environmentId === null) {
      return;
    }
    void fixFinding({ environmentId, input: { reviewId: run.id, findingId } });
  };

  const FixAllButton = (
    <button
      type="button"
      className="shrink-0 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
      onClick={fixAll}
      disabled={anyFixing || fixableFindings.length === 0}
    >
      Fix all with AI
    </button>
  );

  return (
    <div className="flex shrink-0 flex-col border-b border-border/60" style={{ height }}>
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Review findings
        </span>
        {run.verdict ? (
          <span
            className={`rounded-sm px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              run.verdict === "approve"
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-amber-500/15 text-amber-500"
            }`}
          >
            {run.verdict === "approve" ? "Approved" : "Changes requested"}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
          {visibleFindings.length} total
        </span>
        {FixAllButton}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {visibleFindings.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground/80">
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
            <span className="font-medium text-foreground">
              {run.findings.length > 0
                ? "All findings dismissed."
                : "No issues found — this review is clean."}
            </span>
            {run.summary ? (
              <span className="min-w-0 truncate text-muted-foreground">{run.summary}</span>
            ) : null}
          </div>
        ) : (
          visibleFindings.map((finding) => (
            <div
              key={finding.id}
              className="rounded-md border border-border/60 bg-background px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`shrink-0 text-[11px] font-semibold uppercase tracking-wide ${SEVERITY_CLASS[finding.severity]}`}
                  >
                    {reviewSeverityLabel(finding.severity)}
                  </span>
                  {isFindingPlaceable(finding, files) ? null : finding.line !== null ? (
                    <span className="shrink-0 rounded-sm bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
                      Outdated
                    </span>
                  ) : null}
                  <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                    {finding.file}
                    {finding.line !== null ? `:${finding.line}` : ""}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {finding.fixState === "fixed" ? (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-500">
                      <CheckIcon className="size-3" />
                      Fixed
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                      onClick={() => fixOne(finding.id)}
                      disabled={finding.fixState === "fixing"}
                      title={
                        finding.fixState === "failed"
                          ? (finding.fixError ?? "Fix failed.")
                          : undefined
                      }
                    >
                      {finding.fixState === "fixing" ? (
                        <LoaderIcon className="size-3 animate-spin" />
                      ) : (
                        <WandSparklesIcon className="size-3" />
                      )}
                      {finding.fixState === "fixing"
                        ? "Fixing…"
                        : finding.fixState === "failed"
                          ? "Retry fix"
                          : "Fix with AI"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Dismiss finding in ${finding.file}`}
                    onClick={() => dismissFinding(run.id, finding.id)}
                  >
                    <Trash2Icon className="size-3" />
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-foreground/90">{finding.message}</p>
              {finding.fixState === "failed" && finding.fixError ? (
                <p className="mt-1 truncate text-[11px] text-amber-500" title={finding.fixError}>
                  {finding.fixError}
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div
        role="separator"
        aria-label="Resize review findings"
        className="h-1 shrink-0 cursor-ns-resize touch-none border-t border-border/60 bg-transparent transition-colors hover:bg-accent"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
