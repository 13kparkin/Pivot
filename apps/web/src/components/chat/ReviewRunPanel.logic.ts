import type { ReviewFinding } from "@t3tools/contracts";

export type ReviewFileProgressState = "pending" | "in-progress" | "done";

/**
 * Normalize an activity target to a workspace path: strip the `:line`,
 * `:start-end`, or `:raw` selectors appended to read targets
 * (`src/a.ts:12-20:raw` → `src/a.ts`). Targets may be absolute
 * (`/home/…/repo/src/a.ts:12-20:raw`), so matching below is by suffix.
 */
function normalizeActivityTarget(title: string): string {
  return title.replace(/:\d+(?:-\d+)?(?::raw)?$/u, "");
}

/** Whether a normalized target names a roster path, relative or absolute. */
function matchesRosterPath(target: string, path: string): boolean {
  return target === path || target.endsWith(`/${path}`);
}

/** How many of the most recent activity items count as "currently working on". */
const IN_PROGRESS_WINDOW = 3;

/**
 * Derive each changed file's review-progress state from the run's live
 * activity and findings. A file is `done` once a finding lands for it, or —
 * once the run completes — when the `filesReviewed` ledger names it. It is
 * `in-progress` while recent activity (a read/grep targeting it, or a
 * subagent description naming it) points at it, and `pending` otherwise.
 * Done files never revert, so the list settles into the coverage ledger at
 * completion.
 */
export function deriveReviewFileProgress(input: {
  readonly files: ReadonlyArray<string>;
  readonly activity: ReadonlyArray<{ readonly kind: string; readonly title: string }> | undefined;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly filesReviewed: ReadonlyArray<string> | undefined;
  readonly status: string;
}): ReadonlyMap<string, ReviewFileProgressState> {
  const states = new Map<string, ReviewFileProgressState>(
    input.files.map((file) => [file, "pending"]),
  );
  const done = new Set<string>([
    ...input.findings.map((finding) => finding.file),
    ...(input.status === "completed" ? (input.filesReviewed ?? []) : []),
  ]);
  for (const file of done) {
    if (states.has(file)) {
      states.set(file, "done");
    }
  }
  for (const item of (input.activity ?? []).slice(-IN_PROGRESS_WINDOW)) {
    const target = normalizeActivityTarget(item.title);
    if (item.kind === "subagent") {
      for (const file of input.files) {
        if (states.get(file) === "pending" && item.title.includes(file)) {
          states.set(file, "in-progress");
        }
      }
      continue;
    }
    for (const file of input.files) {
      if (states.get(file) === "pending" && matchesRosterPath(target, file)) {
        states.set(file, "in-progress");
      }
    }
  }
  return states;
}
