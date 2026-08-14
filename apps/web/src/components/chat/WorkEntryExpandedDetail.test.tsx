import { vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkEntryExpandedDetail } from "./WorkEntryExpandedDetail";
import type { WorkLogEntry } from "../../session-logic";

function baseEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "work-1",
    createdAt: "2026-03-17T19:12:28.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  };
}

const TURN_SUMMARY = {
  files: [{ path: "apps/web/src/session-logic.ts", kind: "modified", additions: 12, deletions: 3 }],
};

describe("WorkEntryExpandedDetail", () => {
  it("renders command output, raw command, and exit code for command rows", () => {
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({
          itemType: "command_execution",
          command: "bun run lint",
          rawCommand: "bun run lint --fix",
          toolData: { rawOutput: { exitCode: 1, stdout: "Found 3 errors" } },
        })}
        workspaceRoot="/proj"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toContain("Command");
    expect(markup).toContain("bun run lint");
    expect(markup).toContain("Raw command");
    expect(markup).toContain("bun run lint --fix");
    expect(markup).toContain("Output");
    expect(markup).toContain("Found 3 errors");
    expect(markup).toContain("Exit code");
    expect(markup).toContain("1");
  });

  it("renders structured MCP arguments and result", () => {
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({
          itemType: "mcp_tool_call",
          toolData: {
            server: "t3-code",
            tool: "preview_status",
            arguments: { interactiveOnly: true },
            result: { content: [{ type: "text", text: "attached" }] },
          },
        })}
        workspaceRoot="/proj"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toContain("Arguments");
    expect(markup).toContain("&quot;interactiveOnly&quot;: true");
    expect(markup).toContain("Result");
    expect(markup).toContain("attached");
  });

  it("renders advisor notes with severity tint and attribution", () => {
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({
          sourceActivityKind: "advisor.comment",
          advisorNotes: [
            { note: "Consider extracting the helper", severity: "concern", advisor: "code-review" },
            { note: "Nit: rename the variable", severity: "nit" },
          ],
        })}
        workspaceRoot="/proj"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toContain("Consider extracting the helper");
    expect(markup).toContain("code-review");
    expect(markup).toContain("Concern");
    expect(markup).toContain("Nit: rename the variable");
  });

  it("renders ttsr rule context with conditions and interrupt mode", () => {
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({
          sourceActivityKind: "ttsr.triggered",
          ttsrRules: [
            {
              name: "codegraph",
              path: "/home/kyle/.omp/agent/rules/codegraph.md",
              description: "Query CodeGraph before searching",
              condition: ["grep-like search"],
              interruptMode: "always",
            },
          ],
        })}
        workspaceRoot="/proj"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toContain("codegraph");
    expect(markup).toContain("Query CodeGraph before searching");
    expect(markup).toContain("grep-like search");
    expect(markup).toContain("Always interrupts");
    expect(markup).toContain("/home/kyle/.omp/agent/rules/codegraph.md");
  });

  it("renders per-file diff preview with an open-full-diff deep link for file changes", () => {
    const onOpenTurnDiff = vi.fn();
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({
          itemType: "file_change",
          turnId: "turn-1" as never,
          changedFiles: ["apps/web/src/session-logic.ts"],
        })}
        workspaceRoot="/proj"
        turnSummary={TURN_SUMMARY}
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    expect(markup).toContain("session-logic.ts");
    expect(markup).toContain("+12");
    expect(markup).toContain("-3");
    expect(markup).toContain("Open full diff");
  });

  it("carries the file path on the open-full-diff deep link", () => {
    const onOpenTurnDiff = vi.fn();
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({
          itemType: "file_change",
          turnId: "turn-1" as never,
          changedFiles: ["apps/web/src/session-logic.ts"],
        })}
        workspaceRoot="/proj"
        turnSummary={TURN_SUMMARY}
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    // The deep-link affordance is per-file: the row passes the entry's turnId
    // and the changed-file path through to onOpenTurnDiff (ChatView wires it
    // to selectTurn + open the DiffPanel at that file). Click-through is
    // exercised manually (AC2); static markup asserts the wiring target.
    expect(markup).toContain('aria-label="Open full diff for apps/web/src/session-logic.ts"');
  });

  it("renders nothing for entries with no detail", () => {
    const markup = renderToStaticMarkup(
      <WorkEntryExpandedDetail
        workEntry={baseEntry({ label: "Context compacted", tone: "info" })}
        workspaceRoot="/proj"
        onOpenTurnDiff={vi.fn()}
      />,
    );

    expect(markup).toBe("");
  });
});
