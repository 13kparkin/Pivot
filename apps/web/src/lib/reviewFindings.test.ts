import { describe, expect, it } from "vite-plus/test";

import {
  reviewFindingBody,
  reviewFindingToReviewThread,
  reviewSeverityLabel,
} from "./reviewFindings";

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
});
