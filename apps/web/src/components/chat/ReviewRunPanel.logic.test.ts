import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { deriveReviewRunCoverage } from "./ReviewRunPanel.logic";

function fileDiff(): FileDiffMetadata {
  // New-file lines 1 (context) and 2-3 (additions); old-file lines 1 (context)
  // and 2 (deletion).
  return {
    type: "change",
    prevName: "a/src/a.ts",
    name: "b/src/a.ts",
    additions: 2,
    deletions: 1,
    additionLines: ["context-1", "added-2", "added-3"],
    deletionLines: ["unused-context-1", "removed-old-2"],
    hunks: [
      {
        deletionStart: 1,
        deletionLineIndex: 0,
        additionStart: 1,
        additionLineIndex: 0,
        hunkContent: [
          { type: "context", lines: 1 },
          { type: "change", deletions: 1, additions: 2 },
        ],
      },
    ],
  } as unknown as FileDiffMetadata;
}

const files = [
  { fileDiff: fileDiff(), filePath: "src/a.ts" },
  { fileDiff: fileDiff(), filePath: "src/b.ts" },
];

function finding(
  overrides: Partial<Parameters<typeof deriveReviewRunCoverage>[0]["findings"][number]> = {},
): Parameters<typeof deriveReviewRunCoverage>[0]["findings"][number] {
  return {
    id: "finding-1",
    file: "src/a.ts",
    line: 3,
    side: "right",
    severity: "blocking",
    message: "Inline the single-use helper.",
    symbol: "doThing",
    ...overrides,
  } as Parameters<typeof deriveReviewRunCoverage>[0]["findings"][number];
}

describe("deriveReviewRunCoverage", () => {
  it("covers filesReviewed entries that are in the rendered diff", () => {
    const view = deriveReviewRunCoverage({
      filesReviewed: ["src/a.ts", "src/gone.ts"],
      findings: [],
      files,
    });
    expect(view.covered).toEqual(["src/a.ts"]);
  });

  it("flags rendered files missing from filesReviewed", () => {
    const view = deriveReviewRunCoverage({
      filesReviewed: ["src/a.ts"],
      findings: [],
      files,
    });
    expect(view.missing).toEqual(["src/b.ts"]);
  });

  it("treats an absent filesReviewed as covering nothing", () => {
    const view = deriveReviewRunCoverage({ filesReviewed: undefined, findings: [], files });
    expect(view.covered).toEqual([]);
    expect(view.missing).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("marks findings with a rejected line as outdated, not file-level findings", () => {
    const view = deriveReviewRunCoverage({
      filesReviewed: ["src/a.ts"],
      findings: [
        finding({ id: "finding-1", line: 99 }),
        finding({ id: "finding-2", file: "src/b.ts", line: null }),
      ],
      files,
    });
    expect(view.outdatedFindings.map((entry) => entry.id)).toEqual(["finding-1"]);
  });
});
