import { describe, expect, it } from "vite-plus/test";

import {
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskBranchLabel,
  resolveNewTaskWorkspaceLabel,
  shouldCheckoutNewTaskBranch,
} from "./new-task-context-presentation";

describe("resolveNewTaskBranchWorktreePath", () => {
  it("moves Current checkout to the selected existing worktree", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "local",
        projectCwd: "/repo",
        branchWorktreePath: "/repo/.t3/worktrees/feature",
      }),
    ).toBe("/repo/.t3/worktrees/feature");
  });

  it("keeps the project checkout represented by a null override", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "local",
        projectCwd: "/repo",
        branchWorktreePath: "/repo",
      }),
    ).toBeNull();
  });

  it("does not reuse an existing worktree while creating a new one", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "worktree",
        projectCwd: "/repo",
        branchWorktreePath: "/repo/.t3/worktrees/feature",
      }),
    ).toBeNull();
  });
});

describe("resolveNewTaskWorkspaceLabel", () => {
  it("labels the project checkout", () => {
    expect(resolveNewTaskWorkspaceLabel({ workspaceMode: "local", worktreePath: null })).toBe(
      "Current checkout",
    );
  });

  it("labels an existing selected worktree", () => {
    expect(
      resolveNewTaskWorkspaceLabel({
        workspaceMode: "local",
        worktreePath: "/repo/.t3/worktrees/feature",
      }),
    ).toBe("Current worktree");
  });

  it("keeps creation mode labeled as a new worktree", () => {
    expect(
      resolveNewTaskWorkspaceLabel({
        workspaceMode: "worktree",
        worktreePath: "/repo/.t3/worktrees/ignored",
      }),
    ).toBe("New worktree");
  });
});

describe("resolveNewTaskBranchLabel", () => {
  it("shows the checked-out branch without a base-ref prefix", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "feature/mobile",
        startFromOrigin: true,
        workspaceMode: "local",
      }),
    ).toBe("feature/mobile");
  });

  it("labels a local worktree base with From", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "main",
        startFromOrigin: false,
        workspaceMode: "worktree",
      }),
    ).toBe("From main");
  });

  it("labels a remote worktree base with From origin", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "main",
        startFromOrigin: true,
        workspaceMode: "worktree",
      }),
    ).toBe("From origin/main");
  });

  it("prompts when no branch is available", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: null,
        startFromOrigin: true,
        workspaceMode: "worktree",
      }),
    ).toBe("Choose branch");
  });
});

describe("shouldCheckoutNewTaskBranch", () => {
  it("switches refs for a different branch in Current checkout", () => {
    expect(
      shouldCheckoutNewTaskBranch({
        branchIsCurrent: false,
        branchWorktreePath: null,
        workspaceMode: "local",
      }),
    ).toBe(true);
  });

  it("does not switch refs while choosing a new worktree base", () => {
    expect(
      shouldCheckoutNewTaskBranch({
        branchIsCurrent: false,
        branchWorktreePath: null,
        workspaceMode: "worktree",
      }),
    ).toBe(false);
  });

  it("reuses an existing branch checkout without switching it", () => {
    expect(
      shouldCheckoutNewTaskBranch({
        branchIsCurrent: false,
        branchWorktreePath: "/repo-worktrees/feature",
        workspaceMode: "local",
      }),
    ).toBe(false);
  });
});
