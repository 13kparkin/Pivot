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
import {
  CheckIcon,
  LoaderIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from "lucide-react";

import { dismissFinding, useDismissedFindingIds, useReviewRun } from "../../state/reviewRuns";
import { isFindingPlaceable, reviewSeverityLabel } from "../../lib/reviewFindings";
import { deriveReviewFileProgress } from "@t3tools/client-runtime/state/review-progress";
import { deriveUnreviewedLines } from "../../lib/reviewLineCoverage";
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

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useElapsedSeconds(since: string | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (since === null) {
      return;
    }
    const startedAt = Date.parse(since);
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [since]);
  return elapsed;
}

function readInitialHeight(): number {
  const stored = Number(localStorage.getItem(HEIGHT_STORAGE_KEY));
  if (Number.isFinite(stored) && stored >= MIN_HEIGHT && stored <= MAX_HEIGHT) {
    return stored;
  }
  return 288;
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
 * The review run in the thread diff view. While it runs: a "Reviewing
 * changes…" header with the elapsed timer, and a per-file progress roster —
 * each changed file shows a spinner while the agent is on it, a green check
 * once it is done, and the findings for that file appear under it as they
 * arrive. The same roster stays after completion (all files checked), with
 * "Fix with AI" per finding and "Fix all with AI" in the verdict header.
 * Clicking a finding calls `onSelectFinding` so the host can jump the diff to
 * the finding's line. The card's height is user-resizable via the bottom drag
 * handle.
 */
export function ReviewRunPanel({
  environmentId,
  reviewId,
  files,
  onSelectFinding,
}: {
  environmentId: EnvironmentId | null;
  reviewId: ReviewId | null;
  /** The rendered diff files the review is checked against. */
  files: ReadonlyArray<{ readonly fileDiff: FileDiffMetadata; readonly filePath: string }>;
  /** Jump the diff to a finding's line (GitHub-comment style). */
  onSelectFinding?: (finding: ReviewFinding) => void;
}) {
  const run = useReviewRun(environmentId, reviewId);
  const dismissed = useDismissedFindingIds(reviewId);
  const elapsedSeconds = useElapsedSeconds(run?.createdAt ?? null);
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

  if (run === null) {
    return null;
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

  const threadId = run.threadRef?.threadId ?? null;
  const canFix = environmentId !== null && threadId !== null;
  const roster = files.map((file) => file.filePath);
  const states = deriveReviewFileProgress({
    files: roster,
    activity: run.progress?.activity,
    findings: run.findings,
    filesReviewed: run.filesReviewed,
    status: run.status,
  });

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

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-border/60"
      style={{ height }}
    >
      {run.status === "running" ? (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs">
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <span className="font-medium text-foreground">Reviewing changes…</span>
          <span className="ml-auto text-muted-foreground tabular-nums">
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
      ) : (
        <div
          className={`flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs ${
            run.verdict === "approve" ? "bg-emerald-500/8" : "bg-amber-500/8"
          }`}
        >
          {run.verdict === "approve" ? (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-500" />
          )}
          <span className="font-medium text-foreground">
            {run.verdict === "approve" ? "Approved" : "Changes requested"}
          </span>
          {run.summary ? (
            <span className="min-w-0 truncate text-muted-foreground">{run.summary}</span>
          ) : null}
          {canFix ? (
            <button
              type="button"
              className="ml-auto shrink-0 rounded-md border border-border/70 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              onClick={fixAll}
              disabled={
                run.findings.length === 0 ||
                run.findings.every((finding) => dispatchedFindingIds.has(finding.id))
              }
            >
              Fix all with AI
            </button>
          ) : null}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {roster.length === 0 ? (
          <div className="px-1 py-1 text-xs text-muted-foreground/70">
            No changed files in this diff.
          </div>
        ) : (
          files.map(({ fileDiff, filePath }) => {
            const state = states.get(filePath) ?? "pending";
            const coverageEntry = run.lineCoverage?.find((entry) => entry.file === filePath);
            const unreviewedLines = deriveUnreviewedLines({
              fileDiff,
              coveredRanges: coverageEntry?.lines,
            });
            const fileFindings = run.findings.filter(
              (finding) => finding.file === filePath && !dismissed.has(finding.id),
            );
            return (
              <div key={filePath} className="mb-1">
                <div className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/40">
                  {state === "in-progress" ? (
                    <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : state === "done" ? (
                    <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <span className="size-3.5 shrink-0 rounded-full border border-border/60" />
                  )}
                  <span
                    className={`min-w-0 truncate font-mono text-xs ${
                      state === "pending" ? "text-muted-foreground/60" : "text-foreground/90"
                    }`}
                  >
                    {filePath}
                  </span>
                  {fileFindings.length > 0 ? (
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                      {fileFindings.length} {fileFindings.length === 1 ? "finding" : "findings"}
                    </span>
                  ) : null}
                </div>
                {run.status === "completed" && unreviewedLines.length > 0 ? (
                  <div className="ml-6 flex items-center gap-1 text-[11px] font-medium text-amber-500">
                    <TriangleAlertIcon className="size-3 shrink-0" />
                    {unreviewedLines.length}{" "}
                    {unreviewedLines.length === 1 ? "changed line" : "changed lines"} not explicitly
                    reviewed
                  </div>
                ) : null}
                {fileFindings.map((finding) => (
                  <div
                    key={finding.id}
                    className="ml-5 mt-0.5 rounded-md border border-border/60 bg-background px-2 py-1.5"
                  >
                    <button
                      type="button"
                      className="block w-full text-left"
                      onClick={() => onSelectFinding?.(finding)}
                      disabled={onSelectFinding === undefined}
                    >
                      <span className="flex items-center gap-2">
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
                      </span>
                      <p className="mt-1 text-xs leading-relaxed text-foreground/90">
                        {finding.message}
                      </p>
                    </button>
                    {canFix ? (
                      <div className="mt-1 flex items-center gap-1">
                        {dispatchedFindingIds.has(finding.id) ? (
                          <span className="text-[11px] font-medium text-muted-foreground">
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
                    ) : null}
                  </div>
                ))}
              </div>
            );
          })
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
