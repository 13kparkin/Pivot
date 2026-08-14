/**
 * Type-aware expanded body for work-log rows. One owner of the
 * itemType/sourceActivityKind -> body mapping; rows stay dumb and collapse
 * to the single toggle as before.
 */
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import {
  advisorToneFromSeverity,
  buildMcpCallSections,
  extractCommandExitCode,
} from "./workEntryPresentation";

function formatWorkspaceRelativePath(filePath: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) {
    return filePath;
  }
  const relative = filePath.slice(workspaceRoot.length).replace(/^[/\\]/, "");
  return relative.length > 0 ? relative : filePath;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Section({ label, children }: { label?: string; children: React.ReactNode }) {
  if (label === undefined) {
    return <div className="space-y-0.5">{children}</div>;
  }
  return (
    <div className="space-y-0.5">
      {label ? (
        <p className="text-secondary-label font-medium text-[11px] uppercase tracking-wide">
          {label}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function MonoBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-sm bg-accent/40 px-2 py-1.5 font-mono text-secondary-label text-[11px] leading-relaxed select-text">
      {text}
    </pre>
  );
}

function CommandDetail({ workEntry }: { workEntry: WorkLogEntry }) {
  const command = workEntry.command?.trim();
  const rawCommand = workEntry.rawCommand?.trim();
  const exitCode = extractCommandExitCode(workEntry);
  const data = asRecord(workEntry.toolData);
  const rawOutput = asRecord(data?.rawOutput);
  const outputText =
    (typeof rawOutput?.content === "string" && rawOutput.content.trim()) ||
    (typeof rawOutput?.stdout === "string" && rawOutput.stdout.trim());
  const blocks: Array<{ label?: string; text: string }> = [];
  if (command) {
    blocks.push({ label: "Command", text: command });
  }
  if (rawCommand && rawCommand !== command) {
    blocks.push({ label: "Raw command", text: rawCommand });
  }
  if (outputText) {
    blocks.push({ label: "Output", text: outputText });
  } else if (workEntry.detail?.trim()) {
    blocks.push({ label: "Output", text: workEntry.detail.trim() });
  }
  if (exitCode !== null) {
    blocks.push({
      label: "Exit code",
      text: String(exitCode),
    });
  }
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1.5">
      {blocks.map((block, index) => (
        <Section key={index} {...(block.label === undefined ? {} : { label: block.label })}>
          <MonoBlock text={block.text} />
        </Section>
      ))}
    </div>
  );
}

function McpCallDetail({ workEntry }: { workEntry: WorkLogEntry }) {
  const sections = buildMcpCallSections(workEntry.toolData);
  if (sections.length === 0 && !workEntry.detail?.trim()) {
    return null;
  }
  return (
    <div className="space-y-1.5">
      {sections.map((section) => (
        <Section key={section.label} label={section.label}>
          <MonoBlock text={formatValue(section.value)} />
        </Section>
      ))}
      {workEntry.detail?.trim() ? (
        <Section>
          <MonoBlock text={workEntry.detail.trim()} />
        </Section>
      ) : null}
    </div>
  );
}

function WebSearchDetail({ workEntry }: { workEntry: WorkLogEntry }) {
  const data = asRecord(workEntry.toolData);
  const rawOutput = asRecord(data?.rawOutput);
  const resultLines: string[] = [];
  if (typeof rawOutput?.content === "string" && rawOutput.content.trim()) {
    resultLines.push(rawOutput.content.trim());
  } else if (typeof rawOutput?.stdout === "string" && rawOutput.stdout.trim()) {
    resultLines.push(rawOutput.stdout.trim());
  } else if (rawOutput && "results" in rawOutput) {
    resultLines.push(formatValue(rawOutput.results));
  }
  const query = workEntry.command?.trim() ?? workEntry.detail?.trim();
  if (!query && resultLines.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1.5">
      {query ? (
        <Section label="Query">
          <MonoBlock text={query} />
        </Section>
      ) : null}
      {resultLines.length > 0 ? (
        <Section label="Results">
          <MonoBlock text={resultLines.join("\n")} />
        </Section>
      ) : null}
    </div>
  );
}

const ADVISOR_SEVERITY_CLASS: Record<
  "error" | "warning" | "info",
  { rail: string; label: string }
> = {
  error: { rail: "bg-destructive", label: "Blocked" },
  warning: { rail: "bg-warning", label: "Concern" },
  info: { rail: "bg-muted-foreground/40", label: "Note" },
};

function AdvisorDetail({ workEntry }: { workEntry: WorkLogEntry }) {
  const notes = workEntry.advisorNotes ?? [];
  if (notes.length === 0) {
    return null;
  }
  const tone = advisorToneFromSeverity(notes);
  const severityClass = ADVISOR_SEVERITY_CLASS[tone];
  return (
    <div className="space-y-1.5">
      {notes.map((note, index) => (
        <div key={index} className="flex items-start gap-2">
          <span className={cn("mt-1.5 h-3 w-0.5 shrink-0 rounded-full", severityClass.rail)} />
          <div className="min-w-0 flex-1">
            <p className="text-secondary-label text-[11px] leading-relaxed">
              {note.note}
              {note.advisor ? (
                <span className="text-muted-foreground/60"> — {note.advisor}</span>
              ) : null}
            </p>
            {note.severity ? (
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                {severityClass.label}
              </p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

const TTSR_INTERRUPT_MODE_LABEL: Record<string, string> = {
  never: "Never interrupts",
  "prose-only": "Interrupts prose only",
  "tool-only": "Interrupts tools only",
  always: "Always interrupts",
};

function TtsrDetail({ workEntry }: { workEntry: WorkLogEntry }) {
  const rules = workEntry.ttsrRules ?? [];
  if (rules.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1.5">
      {rules.map((rule, index) => (
        <div key={index} className="space-y-0.5">
          <p className="font-medium text-foreground text-[11px]">{rule.name}</p>
          {rule.description ? (
            <p className="text-secondary-label text-[11px] leading-relaxed">{rule.description}</p>
          ) : null}
          {rule.condition && rule.condition.length > 0 ? (
            <p className="text-secondary-label text-[11px]">
              <span className="text-muted-foreground/60">Matches: </span>
              {rule.condition.join(" · ")}
            </p>
          ) : null}
          <p className="text-muted-foreground/60 font-mono text-[10px]">{rule.path}</p>
          {rule.interruptMode ? (
            <p className="text-muted-foreground/60 text-[10px] uppercase tracking-wide">
              {TTSR_INTERRUPT_MODE_LABEL[rule.interruptMode] ?? rule.interruptMode}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function FlatTextDetail({
  workEntry,
  workspaceRoot,
}: {
  workEntry: WorkLogEntry;
  workspaceRoot: string | undefined;
}) {
  const blocks: string[] = [];
  const rawCommand = workEntry.rawCommand?.trim();
  if (rawCommand) {
    blocks.push(rawCommand);
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  if (blocks.length === 0) {
    return null;
  }
  return <MonoBlock text={blocks.join("\n\n")} />;
}

export function WorkEntryExpandedDetail({
  workEntry,
  workspaceRoot,
}: {
  workEntry: WorkLogEntry;
  workspaceRoot: string | undefined;
}) {
  switch (workEntry.itemType ?? workEntry.sourceActivityKind) {
    case "command_execution":
      return <CommandDetail workEntry={workEntry} />;
    case "mcp_tool_call":
      return <McpCallDetail workEntry={workEntry} />;
    case "web_search":
      return <WebSearchDetail workEntry={workEntry} />;
    case "advisor.comment":
      return <AdvisorDetail workEntry={workEntry} />;
    case "ttsr.triggered":
      return <TtsrDetail workEntry={workEntry} />;
    default:
      return <FlatTextDetail workEntry={workEntry} workspaceRoot={workspaceRoot} />;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
