import type { ReviewSource } from "@t3tools/contracts";

/**
 * The diff panel's scope selection, normalized: a thread turn's checkpoint
 * diff, the uncommitted working tree, or committed-but-unpushed branch
 * changes against a base ref.
 */
export type DiffScopeKind = "turn" | "working-tree" | "branch";

export interface DiffScopeSelection {
  readonly kind: "turn" | "unstaged" | "branch";
  readonly turnId?: string | null;
}

export function diffScopeKind(selection: DiffScopeSelection): DiffScopeKind {
  if (selection.kind === "turn") {
    return "turn";
  }
  return selection.kind === "unstaged" ? "working-tree" : "branch";
}

export function diffScopeLabel(input: {
  readonly scopeKind: DiffScopeKind;
  readonly gitScope: "unstaged" | "branch";
  readonly isLatestTurn: boolean;
  readonly turnCount: number | null;
}): string {
  switch (input.scopeKind) {
    case "working-tree":
      return "Working tree";
    case "branch":
      return "Branch changes";
    case "turn":
      return input.isLatestTurn ? "Latest turn" : `Turn ${input.turnCount ?? "?"}`;
  }
}

/** The section key review findings + collapse state are scoped to. */
export function reviewSectionKey(input: {
  readonly scopeKind: DiffScopeKind;
  readonly turnId: string | null;
  readonly gitScope: "unstaged" | "branch";
}): string {
  return input.scopeKind === "turn" ? `turn:${input.turnId}` : input.gitScope;
}

export function reviewSectionTitle(input: {
  readonly scopeKind: DiffScopeKind;
  readonly gitScope: "unstaged" | "branch";
  readonly turnCount: number | null;
}): string {
  switch (input.scopeKind) {
    case "turn":
      return `Turn ${input.turnCount ?? "?"}`;
    case "working-tree":
      return "Working tree";
    case "branch":
      return "Branch changes";
  }
}

/** The change a review runs on for the selected git scope. */
export function reviewSourceForScope(
  gitScope: "unstaged" | "branch",
  baseRef: string | null,
): ReviewSource {
  return gitScope === "unstaged" ? { kind: "working-tree" } : { kind: "branch-range", baseRef };
}

export type DiffEmptyState =
  | "no-completed-turns"
  | "loading"
  | "no-net-changes"
  | "no-patch"
  | null;

/** What the diff viewport shows instead of a patch, if anything. */
export function deriveDiffEmptyState(input: {
  readonly scopeKind: DiffScopeKind;
  readonly hasTurnSummaries: boolean;
  readonly isLoadingPatch: boolean;
  readonly hasResolvedPatch: boolean;
  readonly hasNetChanges: boolean;
}): DiffEmptyState {
  if (input.scopeKind === "turn" && !input.hasTurnSummaries) {
    return "no-completed-turns";
  }
  if (input.hasResolvedPatch && !input.hasNetChanges) {
    return "no-net-changes";
  }
  if (!input.hasResolvedPatch && !input.isLoadingPatch) {
    return "no-patch";
  }
  if (!input.hasResolvedPatch && input.isLoadingPatch) {
    return "loading";
  }
  return null;
}
