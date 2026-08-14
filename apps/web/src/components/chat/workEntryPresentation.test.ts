import { describe, expect, it } from "vite-plus/test";

import {
  advisorToneFromSeverity,
  buildMcpCallSections,
  deriveWorkEntryDurationMs,
  extractCommandExitCode,
  ttsrRuleSummary,
  workEntryHasExpandedDetail,
} from "./workEntryPresentation";
import type { WorkLogEntry } from "../../session-logic";

const baseEntry: WorkLogEntry = {
  id: "work-1",
  createdAt: "2026-03-17T19:12:28.000Z",
  label: "Ran command",
  tone: "tool",
};

describe("deriveWorkEntryDurationMs", () => {
  it("returns elapsed milliseconds between start and settle", () => {
    expect(deriveWorkEntryDurationMs("2026-03-17T19:12:28.000Z", "2026-03-17T19:12:33.500Z")).toBe(
      5500,
    );
  });

  it("returns null while the entry is still in progress", () => {
    expect(deriveWorkEntryDurationMs("2026-03-17T19:12:28.000Z", null)).toBeNull();
  });

  it("returns null for invalid or backwards timestamps", () => {
    expect(deriveWorkEntryDurationMs("not-a-date", "2026-03-17T19:12:33.000Z")).toBeNull();
    expect(
      deriveWorkEntryDurationMs("2026-03-17T19:12:33.000Z", "2026-03-17T19:12:28.000Z"),
    ).toBeNull();
  });
});

describe("extractCommandExitCode", () => {
  it("reads a numeric exit code from toolData raw output", () => {
    expect(
      extractCommandExitCode({
        ...baseEntry,
        toolData: { rawOutput: { exitCode: 1, stdout: "boom" } },
      }),
    ).toBe(1);
  });

  it("returns null when no exit code is known", () => {
    expect(extractCommandExitCode(baseEntry)).toBeNull();
    expect(
      extractCommandExitCode({ ...baseEntry, toolData: { rawOutput: { stdout: "ok" } } }),
    ).toBeNull();
  });
});

describe("buildMcpCallSections", () => {
  it("splits MCP arguments and result into labeled sections", () => {
    const sections = buildMcpCallSections({
      type: "mcpToolCall",
      server: "t3-code",
      tool: "preview_status",
      arguments: { id: "a1" },
      result: { content: [{ type: "text", text: "attached" }] },
    });

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ label: "Arguments", value: { id: "a1" } });
    expect(sections[1]).toMatchObject({
      label: "Result",
      value: { content: [{ type: "text", text: "attached" }] },
    });
  });

  it("omits missing argument or result sections", () => {
    expect(buildMcpCallSections({ arguments: {} })).toHaveLength(1);
    expect(buildMcpCallSections({ result: "done" })).toHaveLength(1);
    expect(buildMcpCallSections(undefined)).toHaveLength(0);
  });
});

describe("advisorToneFromSeverity", () => {
  it("maps blocker to error, concern to warning, nit to info", () => {
    expect(advisorToneFromSeverity([{ note: "n", severity: "blocker" }])).toBe("error");
    expect(advisorToneFromSeverity([{ note: "n", severity: "concern" }])).toBe("warning");
    expect(advisorToneFromSeverity([{ note: "n", severity: "nit" }])).toBe("info");
  });

  it("lets the highest severity win across a mixed note list", () => {
    expect(
      advisorToneFromSeverity([
        { note: "nit", severity: "nit" },
        { note: "concern", severity: "concern" },
      ]),
    ).toBe("warning");
  });

  it("defaults to info for severity-less notes", () => {
    expect(advisorToneFromSeverity([{ note: "plain" }])).toBe("info");
    expect(advisorToneFromSeverity([])).toBe("info");
  });
});

describe("ttsrRuleSummary", () => {
  it("uses the first rule name for a single rule", () => {
    expect(ttsrRuleSummary([{ name: "codegraph", path: "/rules/codegraph.md" }])).toBe("codegraph");
  });

  it("counts additional rules beyond the first", () => {
    expect(
      ttsrRuleSummary([
        { name: "codegraph", path: "/rules/codegraph.md" },
        { name: "branch-name", path: "/rules/branch-name.md" },
      ]),
    ).toBe("codegraph +1 more");
  });

  it("falls back for an empty rule list", () => {
    expect(ttsrRuleSummary([])).toBe("No rules");
  });
});

describe("workEntryHasExpandedDetail", () => {
  it("is false for entries with no detail at all", () => {
    expect(workEntryHasExpandedDetail(baseEntry)).toBe(false);
  });

  it("is true for command, MCP, and file-change entries", () => {
    expect(
      workEntryHasExpandedDetail({
        ...baseEntry,
        itemType: "command_execution",
        command: "bun test",
      }),
    ).toBe(true);
    expect(
      workEntryHasExpandedDetail({
        ...baseEntry,
        itemType: "mcp_tool_call",
        toolData: { server: "t3-code", arguments: {} },
      }),
    ).toBe(true);
    expect(
      workEntryHasExpandedDetail({ ...baseEntry, changedFiles: ["apps/web/src/session-logic.ts"] }),
    ).toBe(true);
  });

  it("is true for advisor and ttsr entries", () => {
    expect(
      workEntryHasExpandedDetail({
        ...baseEntry,
        sourceActivityKind: "advisor.comment",
        advisorNotes: [{ note: "Consider extracting this helper" }],
      }),
    ).toBe(true);
    expect(
      workEntryHasExpandedDetail({
        ...baseEntry,
        sourceActivityKind: "ttsr.triggered",
        ttsrRules: [{ name: "codegraph", path: "/rules/codegraph.md" }],
      }),
    ).toBe(true);
  });
});
