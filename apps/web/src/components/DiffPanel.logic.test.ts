import { describe, expect, it } from "vite-plus/test";

import {
  deriveDiffEmptyState,
  diffScopeKind,
  diffScopeLabel,
  reviewSectionKey,
  reviewSectionTitle,
  reviewSourceForScope,
} from "./DiffPanel.logic";

describe("diffScopeKind", () => {
  it("classifies the three selections", () => {
    expect(diffScopeKind({ kind: "turn" })).toBe("turn");
    expect(diffScopeKind({ kind: "unstaged" })).toBe("working-tree");
    expect(diffScopeKind({ kind: "branch" })).toBe("branch");
  });
});

describe("diffScopeLabel", () => {
  it("names git scopes and turns", () => {
    expect(
      diffScopeLabel({
        scopeKind: "working-tree",
        gitScope: "unstaged",
        isLatestTurn: false,
        turnCount: null,
      }),
    ).toBe("Working tree");
    expect(
      diffScopeLabel({
        scopeKind: "branch",
        gitScope: "branch",
        isLatestTurn: false,
        turnCount: null,
      }),
    ).toBe("Branch changes");
    expect(
      diffScopeLabel({ scopeKind: "turn", gitScope: "unstaged", isLatestTurn: true, turnCount: 3 }),
    ).toBe("Latest turn");
    expect(
      diffScopeLabel({
        scopeKind: "turn",
        gitScope: "unstaged",
        isLatestTurn: false,
        turnCount: 3,
      }),
    ).toBe("Turn 3");
  });
});

describe("reviewSectionKey/Title", () => {
  it("scopes turns by id and git scopes by scope", () => {
    expect(reviewSectionKey({ scopeKind: "turn", turnId: "t-1", gitScope: "unstaged" })).toBe(
      "turn:t-1",
    );
    expect(
      reviewSectionKey({ scopeKind: "working-tree", turnId: null, gitScope: "unstaged" }),
    ).toBe("unstaged");
    expect(reviewSectionKey({ scopeKind: "branch", turnId: null, gitScope: "branch" })).toBe(
      "branch",
    );
  });

  it("titles sections for the panel", () => {
    expect(reviewSectionTitle({ scopeKind: "turn", gitScope: "unstaged", turnCount: 4 })).toBe(
      "Turn 4",
    );
    expect(
      reviewSectionTitle({ scopeKind: "working-tree", gitScope: "unstaged", turnCount: null }),
    ).toBe("Working tree");
    expect(reviewSectionTitle({ scopeKind: "branch", gitScope: "branch", turnCount: null })).toBe(
      "Branch changes",
    );
  });
});

describe("reviewSourceForScope", () => {
  it("maps the git scope to the review source", () => {
    expect(reviewSourceForScope("unstaged", null)).toEqual({ kind: "working-tree" });
    expect(reviewSourceForScope("branch", "main")).toEqual({
      kind: "branch-range",
      baseRef: "main",
    });
  });
});

describe("deriveDiffEmptyState", () => {
  it("reports no completed turns when a turn scope has no summaries", () => {
    expect(
      deriveDiffEmptyState({
        scopeKind: "turn",
        hasTurnSummaries: false,
        isLoadingPatch: false,
        hasResolvedPatch: false,
        hasNetChanges: false,
      }),
    ).toBe("no-completed-turns");
  });

  it("reports loading while the patch resolves", () => {
    expect(
      deriveDiffEmptyState({
        scopeKind: "working-tree",
        hasTurnSummaries: true,
        isLoadingPatch: true,
        hasResolvedPatch: false,
        hasNetChanges: false,
      }),
    ).toBe("loading");
  });

  it("reports no net changes for an empty resolved patch", () => {
    expect(
      deriveDiffEmptyState({
        scopeKind: "working-tree",
        hasTurnSummaries: true,
        isLoadingPatch: false,
        hasResolvedPatch: true,
        hasNetChanges: false,
      }),
    ).toBe("no-net-changes");
  });

  it("reports no patch when resolution finished empty", () => {
    expect(
      deriveDiffEmptyState({
        scopeKind: "working-tree",
        hasTurnSummaries: true,
        isLoadingPatch: false,
        hasResolvedPatch: false,
        hasNetChanges: false,
      }),
    ).toBe("no-patch");
  });
});
