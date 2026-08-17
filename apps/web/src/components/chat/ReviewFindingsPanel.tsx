"use client";

import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ReviewFinding,
  type ReviewFindingSeverity,
  type ReviewId,
} from "@t3tools/contracts";
import { CheckIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";

import { dismissFinding, useDismissedFindingIds, useReviewRun } from "../../state/reviewRuns";
import { isFindingPlaceable, reviewSeverityLabel } from "../../lib/reviewFindings";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { newMessageId } from "~/lib/utils";

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

/** The thread-turn prompt that asks the agent to apply a finding's fix. */
function buildFixPrompt(finding: ReviewFinding): string {
  return [
    "Fix one code review finding in this workspace.",
    `File: ${finding.file}`,
    `Line: ${finding.line === null ? "(file-level)" : String(finding.line)}`,
    `Severity: ${finding.severity}`,
    finding.symbol === null ? null : `Symbol: ${finding.symbol}`,
    `Finding: ${finding.message}`,
    "Apply the minimal change that resolves it. Do not refactor unrelated code. " +
      "Verify the change is coherent.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * The review's findings as a height-resizable section above the diff: a
 * header ("Review findings", verdict, count, Fix all with AI) and one row per
 * finding with a per-finding "Fix with AI" action that starts a thread turn
 * (so the fix is a normal, visible, stoppable agent run in the review's host
 * thread). Unplaceable findings keep their Outdated badge; file-level findings
 * stay unbadged. Fix actions need a host thread, so PR-originated reviews
 * (no threadRef) show the findings without fix buttons.
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
  const [dispatchedFindingIds, setDispatchedFindingIds] = useState<ReadonlySet<string>>(new Set());
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  useEffect(() => {
    localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
  }, [height]);

  useEffect(() => {
    setDispatchedFindingIds(new Set());
  }, [reviewId]);

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

  const threadId = run.threadRef?.threadId ?? null;
  const canFix = environmentId !== null && threadId !== null;

  const dispatchFix = (finding: ReviewFinding) => {
    if (!canFix || threadId === null || dispatchedFindingIds.has(finding.id)) {
      return;
    }
    setDispatchedFindingIds((previous) => new Set(previous).add(finding.id));
    void startThreadTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildFixPrompt(finding),
          attachments: [],
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        titleSeed: "Fix review finding",
        createdAt: new Date().toISOString(),
      },
    });
  };

  const fixAll = () => {
    for (const finding of run.findings) {
      dispatchFix(finding);
    }
  };

  const visibleFindings = run.findings.filter((finding) => !dismissed.has(finding.id));
  const allDispatched = run.findings.every((finding) => dispatchedFindingIds.has(finding.id));

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
        {canFix ? (
          <button
            type="button"
            className="shrink-0 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={fixAll}
            disabled={allDispatched || run.findings.length === 0}
          >
            Fix all with AI
          </button>
        ) : null}
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
                  {canFix ? (
                    dispatchedFindingIds.has(finding.id) ? (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        Fix started
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent"
                        onClick={() => dispatchFix(finding)}
                      >
                        <WandSparklesIcon className="size-3" />
                        Fix with AI
                      </button>
                    )
                  ) : null}
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
