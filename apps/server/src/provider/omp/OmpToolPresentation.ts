import type { CanonicalItemType } from "@t3tools/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ompToolKind(toolName: string): string | undefined {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell" || name === "execute") {
    return "execute";
  }
  if (name === "read") {
    return "read";
  }
  if (
    name === "write" ||
    name === "edit" ||
    name === "multiedit" ||
    name.includes("patch") ||
    name.includes("edit")
  ) {
    return "edit";
  }
  if (name.includes("web_search") || name === "websearch" || name === "grep" || name === "find") {
    return "search";
  }
  return undefined;
}

function ompToolItemType(toolName: string): CanonicalItemType {
  const name = toolName.toLowerCase();
  const kind = ompToolKind(toolName);
  if (kind === "execute") {
    return "command_execution";
  }
  if (kind === "edit") {
    return "file_change";
  }
  if (name.includes("web_search") || name === "websearch") {
    return "web_search";
  }
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) {
    return "mcp_tool_call";
  }
  if (name === "task" || name.includes("collab") || name === "agent") {
    return "collab_agent_tool_call";
  }
  // read + other omp tools: dynamic_tool_call + data.kind for UI presentation
  return "dynamic_tool_call";
}

function extractOmpToolCommand(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.command !== "string") {
    return undefined;
  }
  const command = args.command.trim();
  return command.length > 0 ? command : undefined;
}

function extractOmpToolPath(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  for (const key of ["path", "filePath", "filename", "file", "target"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Unwrap omp AgentToolResult `{ content: [{ type:"text", text }] }` to plain text. */
export function formatOmpToolOutputText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const parts: string[] = [];
    for (const entry of value.content) {
      if (isRecord(entry) && typeof entry.text === "string" && entry.text.length > 0) {
        parts.push(entry.text);
      }
    }
    if (parts.length > 0) {
      return parts.join("");
    }
  }
  if (isRecord(value)) {
    if (typeof value.stdout === "string" && value.stdout.length > 0) {
      return value.stdout;
    }
    if (typeof value.text === "string" && value.text.length > 0) {
      return value.text;
    }
  }
  return "";
}

function truncateDetail(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

export interface OmpToolCallPresentation {
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly detail: string | undefined;
  readonly data: Record<string, unknown>;
}

/**
 * Maps a raw omp tool call to the canonical `item.*` presentation the UI
 * renders: item type, title, a truncated detail line (intent, command, or
 * path), and the structured data payload.
 */
export class OmpToolPresentation {
  present(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly intent?: string | undefined;
    readonly result?: unknown;
    readonly isError?: boolean;
  }): OmpToolCallPresentation {
    const kind = ompToolKind(input.toolName);
    const command = extractOmpToolCommand(input.args);
    const path = extractOmpToolPath(input.args);
    const intent =
      typeof input.intent === "string" && input.intent.trim().length > 0
        ? input.intent.trim()
        : undefined;
    const detailSource = intent ?? command ?? path;
    const outputText = formatOmpToolOutputText(input.result);
    return {
      itemType: ompToolItemType(input.toolName),
      title: input.toolName,
      detail: detailSource !== undefined ? truncateDetail(detailSource) : undefined,
      data: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        ...(kind === undefined ? {} : { kind }),
        ...(command === undefined ? {} : { command }),
        ...(input.args === undefined ? {} : { rawInput: input.args, args: input.args }),
        ...(path === undefined ? {} : { locations: [{ path }] }),
        ...(outputText.length > 0 ? { rawOutput: { content: outputText } } : {}),
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.isError === undefined ? {} : { isError: input.isError }),
      },
    };
  }
}
