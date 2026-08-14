/**
 * Pure presentation helpers for work-log expanded detail. Kept beside the
 * row components so each type-aware body stays a thin render over testable
 * derivation (logic-file pattern matching `MessagesTimeline.logic.ts`).
 */
import type { WorkLogEntry } from "../../session-logic";

export function deriveWorkEntryDurationMs(
  createdAt: string,
  settledAt: string | null,
): number | null {
  if (settledAt === null) {
    return null;
  }
  const startedAt = Date.parse(createdAt);
  const endedAt = Date.parse(settledAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return null;
  }
  return endedAt - startedAt;
}

export function extractCommandExitCode(workEntry: Pick<WorkLogEntry, "toolData">): number | null {
  const data = asRecord(workEntry.toolData);
  const rawOutput = asRecord(data?.rawOutput);
  const exitCode = rawOutput?.exitCode;
  return typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null;
}

export function buildMcpCallSections(
  toolData: unknown,
): ReadonlyArray<{ readonly label: string; readonly value: unknown }> {
  const record = asRecord(toolData);
  if (record === null) {
    return [];
  }
  const sections: Array<{ label: string; value: unknown }> = [];
  if (record.arguments !== undefined) {
    sections.push({ label: "Arguments", value: record.arguments });
  }
  if (record.result !== undefined) {
    sections.push({ label: "Result", value: record.result });
  }
  return sections;
}

/** Highest advisor severity wins: blocker -> error, concern -> warning, else info. */
export function advisorToneFromSeverity(
  notes: ReadonlyArray<{
    readonly note: string;
    readonly severity?: "nit" | "concern" | "blocker" | undefined;
    readonly advisor?: string | undefined;
  }>,
): "error" | "warning" | "info" {
  if (notes.some((note) => note.severity === "blocker")) {
    return "error";
  }
  if (notes.some((note) => note.severity === "concern")) {
    return "warning";
  }
  return "info";
}

export function ttsrRuleSummary(
  rules: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly description?: string | undefined;
    readonly interruptMode?: "never" | "prose-only" | "tool-only" | "always" | undefined;
  }>,
): string {
  if (rules.length === 0) {
    return "No rules";
  }
  const firstName = rules[0]?.name ?? "Rule";
  return rules.length === 1 ? firstName : `${firstName} +${rules.length - 1} more`;
}

export interface FileChangeDiffEntry {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Per-file diff rows for a file-change work entry. Paths come from the
 * entry's changedFiles; add/del counts from the turn's checkpoint summary
 * when it names the same path (zero counts otherwise). Sorted by path.
 */
export function buildFileChangeDiffEntries(
  workEntry: Pick<WorkLogEntry, "changedFiles" | "itemType">,
  turnSummary:
    | {
        readonly files: ReadonlyArray<{
          readonly path: string;
          readonly additions: number;
          readonly deletions: number;
        }>;
      }
    | null
    | undefined,
): ReadonlyArray<FileChangeDiffEntry> {
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length === 0) {
    return [];
  }
  const countsByPath = new Map<string, { additions: number; deletions: number }>();
  for (const file of turnSummary?.files ?? []) {
    countsByPath.set(file.path, { additions: file.additions, deletions: file.deletions });
  }
  return changedFiles
    .map((path) => countsByPath.get(path) ?? { additions: 0, deletions: 0 })
    .map((counts, index) => ({
      path: changedFiles[index]!,
      additions: counts.additions,
      deletions: counts.deletions,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export function workEntryHasExpandedDetail(workEntry: WorkLogEntry): boolean {
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    return true;
  }
  if (workEntry.itemType === "command_execution") {
    return true;
  }
  if (workEntry.itemType === "web_search") {
    return true;
  }
  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    return true;
  }
  if ((workEntry.advisorNotes?.length ?? 0) > 0) {
    return true;
  }
  if ((workEntry.ttsrRules?.length ?? 0) > 0) {
    return true;
  }
  return Boolean(
    workEntry.rawCommand?.trim() || workEntry.command?.trim() || workEntry.detail?.trim(),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
