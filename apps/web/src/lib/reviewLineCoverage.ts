import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * The new-file (right-side) line numbers the diff adds: every line of every
 * `change` hunk block, computed from the hunk's addition start + the running
 * offset of context/added lines before it.
 */
export function changedNewFileLines(fileDiff: FileDiffMetadata): ReadonlyArray<number> {
  const lines: number[] = [];
  for (const hunk of fileDiff.hunks) {
    let additionOffset = 0;
    for (const entry of hunk.hunkContent) {
      if (entry.type === "context") {
        additionOffset += entry.lines;
        continue;
      }
      const start = hunk.additionStart + additionOffset;
      for (let i = 0; i < entry.additions; i++) {
        lines.push(start + i);
      }
      additionOffset += entry.additions;
    }
  }
  return lines;
}

interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Parse "1-50" / "60-90" range strings; single numbers become a one-line range. */
function parseCoveredRanges(ranges: ReadonlyArray<string>): ReadonlyArray<LineRange> {
  const parsed: LineRange[] = [];
  for (const range of ranges) {
    const [startText, endText] = range.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
      parsed.push({ start, end });
    }
  }
  return parsed;
}

/**
 * The changed lines of a file the review's coverage attestation did not
 * explicitly account for: the diff's added new-file lines minus the covered
 * ranges. With no attestation, every changed line counts as unreviewed, so a
 * review that omits "coverage" surfaces the whole gap instead of hiding it.
 * Shared by the web diff panel and the mobile review sheet.
 */
export function deriveUnreviewedLines(input: {
  readonly fileDiff: FileDiffMetadata;
  readonly coveredRanges: ReadonlyArray<string> | undefined;
}): ReadonlyArray<number> {
  const changed = changedNewFileLines(input.fileDiff);
  if (input.coveredRanges === undefined || input.coveredRanges.length === 0) {
    return changed;
  }
  const ranges = parseCoveredRanges(input.coveredRanges);
  return changed.filter(
    (line) => !ranges.some((range) => line >= range.start && line <= range.end),
  );
}
