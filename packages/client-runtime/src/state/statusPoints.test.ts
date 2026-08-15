import { describe, expect, it } from "vite-plus/test";

import { splitStatusPoints } from "./statusPoints.ts";

describe("splitStatusPoints", () => {
  it("returns [] for null, undefined, or empty text", () => {
    expect(splitStatusPoints(null)).toEqual([]);
    expect(splitStatusPoints(undefined)).toEqual([]);
    expect(splitStatusPoints("")).toEqual([]);
    expect(splitStatusPoints("   ")).toEqual([]);
  });

  it("keeps a single line as one point", () => {
    expect(splitStatusPoints("Fetching latest upstream.")).toEqual(["Fetching latest upstream."]);
  });

  it("splits newline-separated status lines into one point each", () => {
    expect(splitStatusPoints("Fetching latest upstream.\nNo background jobs running.")).toEqual([
      "Fetching latest upstream.",
      "No background jobs running.",
    ]);
  });

  it("drops blank lines between points", () => {
    expect(splitStatusPoints("First point.\n\nSecond point.\n")).toEqual([
      "First point.",
      "Second point.",
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(splitStatusPoints("First point.\r\nSecond point.\r\n")).toEqual([
      "First point.",
      "Second point.",
    ]);
  });

  it("trims whitespace around each point", () => {
    expect(splitStatusPoints("  First point.  \n\tSecond point.\t")).toEqual([
      "First point.",
      "Second point.",
    ]);
  });
});
