import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFindingPlaceable,
  reviewFindingBody,
  reviewFindingsToDiffComments,
  reviewFindingToReviewThread,
  reviewSeverityLabel,
} from "./reviewFindings";

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

describe("reviewFindings", () => {
  it("maps a finding to a review thread anchored at file + line", () => {
    const thread = reviewFindingToReviewThread(
      {
        id: "finding-1",
        file: "src/a.ts",
        line: 12,
        side: "right",
        severity: "blocking",
        message: "Inline the single-use helper.",
        symbol: "doThing",
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(thread.path).toBe("src/a.ts");
    expect(thread.line).toBe(12);
    expect(thread.side).toBe("right");
    expect(thread.isResolved).toBe(false);
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]?.body).toContain("Blocking");
    expect(thread.comments[0]?.body).toContain("Inline the single-use helper.");
    expect(thread.comments[0]?.body).toContain("`doThing`");
  });

  it("maps a file-level finding with a null line", () => {
    const thread = reviewFindingToReviewThread(
      {
        id: "finding-2",
        file: "src/b.ts",
        line: null,
        side: "right",
        severity: "nit",
        message: "Optional cleanup.",
        symbol: null,
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(thread.line).toBeNull();
    expect(thread.comments[0]?.body).toContain("Nit");
    expect(thread.comments[0]?.body).not.toContain("`");
  });

  it("labels each severity tier", () => {
    expect(reviewSeverityLabel("blocking")).toBe("Blocking");
    expect(reviewSeverityLabel("should-fix")).toBe("Should fix");
    expect(reviewSeverityLabel("nit")).toBe("Nit");
  });

  it("renders a body with the severity + message", () => {
    expect(
      reviewFindingBody({
        id: "f",
        file: "x.ts",
        line: 1,
        side: "right",
        severity: "should-fix",
        message: "Cache this.",
        symbol: null,
      }),
    ).toContain("Should fix");
  });

  describe("reviewFindingsToDiffComments", () => {
    const files = [{ fileDiff: fileDiff(), filePath: "src/a.ts" }];
    const section = { sectionId: "review", sectionTitle: "Review" };
    const finding = (
      overrides: Partial<
        Parameters<typeof reviewFindingsToDiffComments>[0]["findings"][number]
      > = {},
    ) =>
      ({
        id: "finding-1",
        file: "src/a.ts",
        line: 3,
        side: "right",
        severity: "blocking",
        message: "Inline the single-use helper.",
        symbol: "doThing",
        ...overrides,
      }) as Parameters<typeof reviewFindingsToDiffComments>[0]["findings"][number];

    it("places a finding on a rendered addition line", () => {
      const comments = reviewFindingsToDiffComments({
        findings: [finding()],
        files,
        ...section,
      });
      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe("finding-1");
      expect(comments[0]?.filePath).toBe("src/a.ts");
      expect(comments[0]?.text).toContain("Blocking");
      expect(comments[0]?.text).toContain("`doThing`");
    });

    it("anchors a left-side finding to the deletions side", () => {
      const comments = reviewFindingsToDiffComments({
        findings: [finding({ side: "left", line: 2 })],
        files,
        ...section,
      });
      expect(comments).toHaveLength(1);
      expect(comments[0]?.diff).toContain("-removed-old-2");
    });

    it("skips file-level findings with no line", () => {
      const comments = reviewFindingsToDiffComments({
        findings: [finding({ line: null })],
        files,
        ...section,
      });
      expect(comments).toEqual([]);
    });

    it("skips findings for files not in the rendered diff", () => {
      const comments = reviewFindingsToDiffComments({
        findings: [finding({ file: "src/missing.ts" })],
        files,
        ...section,
      });
      expect(comments).toEqual([]);
    });

    it("skips findings anchored to a line no rendered hunk contains", () => {
      const comments = reviewFindingsToDiffComments({
        findings: [finding({ line: 99 })],
        files,
        ...section,
      });
      expect(comments).toEqual([]);
    });
  });

  describe("isFindingPlaceable", () => {
    const files = [{ fileDiff: fileDiff(), filePath: "src/a.ts" }];
    const finding = (
      overrides: Partial<Parameters<typeof isFindingPlaceable>[0]["findings"][number]> = {},
    ) =>
      ({
        id: "finding-1",
        file: "src/a.ts",
        line: 3,
        side: "right",
        severity: "blocking",
        message: "Inline the single-use helper.",
        symbol: "doThing",
        ...overrides,
      }) as Parameters<typeof isFindingPlaceable>[0]["findings"][number];

    it("accepts a finding anchored to a rendered addition line", () => {
      expect(isFindingPlaceable(finding(), files)).toBe(true);
    });

    it("rejects file-level findings with no line", () => {
      expect(isFindingPlaceable(finding({ line: null }), files)).toBe(false);
    });

    it("rejects findings for files not in the rendered diff", () => {
      expect(isFindingPlaceable(finding({ file: "src/missing.ts" }), files)).toBe(false);
    });

    it("rejects findings anchored to a line no rendered hunk contains", () => {
      expect(isFindingPlaceable(finding({ line: 99 }), files)).toBe(false);
    });
  });
});
