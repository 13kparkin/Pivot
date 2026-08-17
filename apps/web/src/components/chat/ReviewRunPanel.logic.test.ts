import { describe, expect, it } from "vite-plus/test";

import { deriveReviewFileProgress } from "./ReviewRunPanel.logic";

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];

function finding(
  overrides: Partial<Parameters<typeof deriveReviewFileProgress>[0]["findings"][number]> = {},
): Parameters<typeof deriveReviewFileProgress>[0]["findings"][number] {
  return {
    id: "finding-1",
    file: "src/a.ts",
    line: 3,
    side: "right",
    severity: "blocking",
    message: "Inline the single-use helper.",
    symbol: "doThing",
    ...overrides,
  } as Parameters<typeof deriveReviewFileProgress>[0]["findings"][number];
}

describe("deriveReviewFileProgress", () => {
  it("starts every file pending", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [],
      findings: [],
      filesReviewed: undefined,
      status: "running",
    });
    expect([...states.values()]).toEqual(["pending", "pending", "pending"]);
  });

  it("marks the file of an arriving finding done", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [],
      findings: [finding()],
      filesReviewed: undefined,
      status: "running",
    });
    expect(states.get("src/a.ts")).toBe("done");
  });

  it("marks ledger files done on completion", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [],
      findings: [],
      filesReviewed: ["src/a.ts", "src/b.ts"],
      status: "completed",
    });
    expect(states.get("src/a.ts")).toBe("done");
    expect(states.get("src/b.ts")).toBe("done");
    expect(states.get("src/c.ts")).toBe("pending");
  });

  it("ignores the ledger while the run is still going", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [],
      findings: [],
      filesReviewed: ["src/a.ts"],
      status: "running",
    });
    expect(states.get("src/a.ts")).toBe("pending");
  });

  it("marks the file of a recent read activity in-progress, stripping selectors", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [{ kind: "read", title: "src/b.ts:12-20:raw" }],
      findings: [],
      filesReviewed: undefined,
      status: "running",
    });
    expect(states.get("src/b.ts")).toBe("in-progress");
  });

  it("matches absolute activity targets by suffix", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [{ kind: "read", title: "/home/dev/repo/apps/src/b.ts:12-20:raw" }],
      findings: [],
      filesReviewed: undefined,
      status: "running",
    });
    expect(states.get("src/b.ts")).toBe("in-progress");
  });

  it("matches bash commands that name a roster file", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [{ kind: "bash", title: "git diff HEAD -- src/c.ts | wc -l" }],
      findings: [],
      filesReviewed: undefined,
      status: "running",
    });
    expect(states.get("src/c.ts")).toBe("in-progress");
  });

  it("keeps done files done when activity names them again", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [{ kind: "read", title: "src/a.ts" }],
      findings: [finding()],
      filesReviewed: undefined,
      status: "running",
    });
    expect(states.get("src/a.ts")).toBe("done");
  });

  it("marks roster files named in a subagent description in-progress", () => {
    const states = deriveReviewFileProgress({
      files: FILES,
      activity: [{ kind: "subagent", title: "review src/c.ts" }],
      findings: [],
      filesReviewed: undefined,
      status: "running",
    });
    expect(states.get("src/c.ts")).toBe("in-progress");
  });
});
