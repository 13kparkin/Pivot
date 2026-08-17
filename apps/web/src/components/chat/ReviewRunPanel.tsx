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
import { reviewSeverityLabel } from "../../lib/reviewFindings";
import { deriveReviewRunCoverage } from "./ReviewRunPanel.logic";
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
 * The review run's live status in the thread diff view: a spinner while it
 * runs (with a live activity feed from the server), the findings once it
 * completes, or an error when it fails. The completed card shows the verdict,
 * the coverage checklist, and the findings — each with a "Fix with AI" action
 * (and "Fix all with AI" in the header) that starts a thread turn in the
 * review's host thread, so the fix is a normal, visible, stoppable agent run.
 * The card's height is user-resizable via the bottom drag handle. Fix actions
 * need a host thread, so PR-originated reviews (no threadRef) show findings
 * without fix buttons.
 */
export function ReviewRunPanel({
  environmentId,
  reviewId,
  files,
}: {
  environmentId: EnvironmentId | null;
  reviewId: ReviewId | null;
  /** The rendered diff files the review is checked against. */
  files: ReadonlyArray<{ readonly fileDiff: FileDiffMetadata; readonly filePath: string }>;
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

  if (run.status === "running") {
    const progress = run.progress;
    const lastActivity = progress?.activity.at(-1) ?? null;
    const filesRead = progress?.activity.filter((item) => item.kind === "read").length ?? 0;
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <span className="font-medium text-foreground">Reviewing changes…</span>
          <span className="ml-auto text-muted-foreground tabular-nums">
            {formatElapsed(elapsedSeconds)}
          </span>
        </div>
        {lastActivity ? (
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="size-1 shrink-0 rounded-full bg-current" />
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground/80">{lastActivity.kind}</span>{" "}
              {lastActivity.title}
            </span>
          </div>
        ) : null}
        {progress && (filesRead > 0 || progress.tokensUsed > 0) ? (
          <div className="text-muted-foreground/80">
            {filesRead > 0 ? `${filesRead} ${filesRead === 1 ? "file" : "files"} read · ` : ""}
            {progress.tokensUsed > 0 ? `${Math.round(progress.tokensUsed / 1_000)}k tokens` : ""}
          </div>
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
  const coverage = deriveReviewRunCoverage({
    filesReviewed: run.filesReviewed,
    findings: run.findings,
    files,
  });
  const coverageStrip =
    files.length > 0 && (coverage.covered.length > 0 || coverage.missing.length > 0) ? (
      <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-medium uppercase tracking-wider text-muted-foreground/70">
            Coverage
          </span>
          <span className="tabular-nums text-muted-foreground/70">
            {coverage.covered.length}/{files.length} files
          </span>
        </div>
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {files.map(({ filePath }) => {
            const covered = coverage.covered.includes(filePath);
            return (
              <li
                key={filePath}
                className={`flex min-w-0 items-center gap-1 font-mono text-[11px] ${
                  covered ? "text-muted-foreground/70" : "font-medium text-amber-500"
                }`}
              >
                {covered ? (
                  <CheckIcon className="size-2.5 shrink-0 text-emerald-500" />
                ) : (
                  <TriangleAlertIcon className="size-2.5 shrink-0 text-amber-500" />
                )}
                <span className="truncate">{filePath}</span>
              </li>
            );
          })}
        </ul>
      </div>
    ) : null;

  if (visibleFindings.length === 0) {
    return (
      <div className="flex max-h-72 flex-col overflow-hidden rounded-lg border border-border/60">
        {coverageStrip}
        <div className="flex items-center gap-2 px-3 py-2 text-xs">
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
      </div>
    );
  }

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-border/60"
      style={{ height }}
    >
      {run.verdict ? (
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
        </div>
      ) : null}
      {coverageStrip}
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>Review findings</span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums">{visibleFindings.length} total</span>
          {canFix ? (
            <button
              type="button"
              className="shrink-0 rounded-md border border-border/70 bg-background px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-foreground/80 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              onClick={fixAll}
              disabled={
                run.findings.length === 0 ||
                run.findings.every((finding) => dispatchedFindingIds.has(finding.id))
              }
            >
              Fix all with AI
            </button>
          ) : null}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
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
                {coverage.outdatedFindings.some((outdated) => outdated.id === finding.id) ? (
                  <span className="ml-2 rounded-sm bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
                    Outdated
                  </span>
                ) : null}
                <span className="ml-2 font-mono text-[11px] text-muted-foreground/70">
                  {finding.file}
                  {finding.line !== null ? `:${finding.line}` : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canFix ? (
                  dispatchedFindingIds.has(finding.id) ? (
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
        ))}
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
