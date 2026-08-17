import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { changedNewFileLines, deriveUnreviewedLines } from "./reviewLineCoverage.ts";

function fileDiff(): FileDiffMetadata {
  // New-file lines 1 (context) and 2-3 (additions); old-file lines 1 (context)
  // and 2 (deletion). A second hunk adds new-file lines 10-11.
  return {
    type: "change",
    prevName: "a/src/a.ts",
    name: "b/src/a.ts",
    additions: 4,
    deletions: 1,
    additionLines: ["context-1", "added-2", "added-3", "context-10", "added-11", "added-12"],
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
      {
        deletionStart: 5,
        deletionLineIndex: 1,
        additionStart: 10,
        additionLineIndex: 0,
        hunkContent: [
          { type: "context", lines: 1 },
          { type: "change", deletions: 0, additions: 2 },
        ],
      },
    ],
  } as unknown as FileDiffMetadata;
}

describe("changedNewFileLines", () => {
  it("lists every added new-file line across hunks", () => {
    expect(changedNewFileLines(fileDiff())).toEqual([2, 3, 11, 12]);
  });
});

describe("deriveUnreviewedLines", () => {
  it("reports every changed line when there is no attestation", () => {
    expect(deriveUnreviewedLines({ fileDiff: fileDiff(), coveredRanges: undefined })).toEqual([
      2, 3, 11, 12,
    ]);
  });

  it("reports no gaps when the attestation covers every changed line", () => {
    expect(
      deriveUnreviewedLines({ fileDiff: fileDiff(), coveredRanges: ["2-3", "11-12"] }),
    ).toEqual([]);
  });

  it("lists the uncovered subset for a partial attestation", () => {
    expect(deriveUnreviewedLines({ fileDiff: fileDiff(), coveredRanges: ["2-3"] })).toEqual([
      11, 12,
    ]);
  });

  it("ignores malformed range strings", () => {
    expect(
      deriveUnreviewedLines({
        fileDiff: fileDiff(),
        coveredRanges: ["2-3", "bogus", "12-5"],
      }),
    ).toEqual([11, 12]);
  });

  it("treats a single-number range as one line", () => {
    expect(deriveUnreviewedLines({ fileDiff: fileDiff(), coveredRanges: ["3", "11-12"] })).toEqual([
      2,
    ]);
  });
});
