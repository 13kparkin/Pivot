import { LegendList } from "@legendapp/list/react";
import type {
  AgentConversationRun,
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  flattenAgentConversationRun,
  formatSubagentDisplayLabel,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CirclePause,
  Moon,
  OctagonX,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";

interface RunHeaderItem {
  readonly kind: "run";
  readonly key: string;
  readonly run: AgentConversationRun;
}

interface AgentRowItem {
  readonly kind: "agent";
  readonly key: string;
  readonly runId: string;
  readonly agent: RuntimeSubagent;
  readonly depth: number;
  readonly hasChildren: boolean;
}

interface CompressedAncestorsItem {
  readonly kind: "ancestors";
  readonly key: string;
  readonly count: number;
  readonly agent: RuntimeSubagent;
}

type BrowserItem = RunHeaderItem | AgentRowItem | CompressedAncestorsItem;

const STATUS_LABEL: Record<RuntimeSubagent["status"], string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

function StatusIcon({ status }: { status: RuntimeSubagent["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "pending":
      return <Circle aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "running":
      return <Circle aria-hidden className={cn(className, "fill-info text-info")} />;
    case "waiting":
      return <CirclePause aria-hidden className={cn(className, "text-warning-foreground")} />;
    case "idle":
      return <Moon aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "completed":
      return <Check aria-hidden className={cn(className, "text-success")} />;
    case "failed":
      return <TriangleAlert aria-hidden className={cn(className, "text-destructive")} />;
    case "cancelled":
    case "interrupted":
      return <OctagonX aria-hidden className={cn(className, "text-muted-foreground")} />;
  }
}

function elapsedLabel(agent: RuntimeSubagent, now: number): string | null {
  if (!agent.startedAt) return null;
  const start = Date.parse(agent.startedAt);
  const end = isActiveSubagentStatus(agent.status)
    ? now
    : agent.completedAt
      ? Date.parse(agent.completedAt)
      : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function AgentTreeRow({
  item,
  selected,
  expanded,
  now,
  onToggle,
  onSelect,
  onKeyDown,
}: {
  item: AgentRowItem;
  selected: boolean;
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const agent = item.agent;
  const label = formatSubagentDisplayLabel(agent);
  const model = formatSubagentModelLabel(agent.model, agent.effort);
  const metrics = [
    model,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    agent.usage?.toolUses === undefined ? null : `${agent.usage.toolUses} tools`,
    elapsedLabel(agent, now),
  ].filter((value): value is string => value !== null);
  const detail =
    agent.activityStatus === "rate_limited"
      ? "Rate limited"
      : agent.activityStatus === "retrying"
        ? "Retrying"
        : (agent.progress ?? agent.error ?? agent.result ?? STATUS_LABEL[agent.status]);
  const visualDepth = Math.min(item.depth, 6);

  return (
    <div
      role="treeitem"
      aria-level={item.depth + 1}
      aria-selected={selected}
      aria-expanded={item.hasChildren ? expanded : undefined}
      className={cn("flex h-16 items-stretch", selected && "bg-accent/55")}
      style={{ paddingLeft: visualDepth * 12 }}
    >
      {item.hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          onClick={onToggle}
          className="flex w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown aria-hidden className="size-3.5" />
          ) : (
            <ChevronRight aria-hidden className="size-3.5" />
          )}
        </button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
      <button
        type="button"
        data-agent-row={item.agent.id}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.1rem_1rem] items-center gap-x-2 px-1.5 py-1 text-left hover:bg-accent/35"
      >
        <StatusIcon status={agent.status} />
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="font-mono text-[.65rem] text-muted-foreground">
          {STATUS_LABEL[agent.status]}
        </span>
        <span className="col-start-2 col-end-4 truncate text-xs text-muted-foreground">
          {detail}
        </span>
        <span className="col-start-2 col-end-4 truncate font-mono text-[.65rem] text-muted-foreground/75">
          {metrics.join(" · ")}
        </span>
      </button>
    </div>
  );
}

export function AgentsPanel({
  model,
  selectedAgentId = null,
  focusedAgentIds = null,
  onSelectAgent,
}: {
  model: AgentPanelModel;
  selectedAgentId?: string | null;
  focusedAgentIds?: ReadonlyArray<string> | null;
  onSelectAgent: (agent: RuntimeSubagent) => void;
}) {
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<string>>(
    () => new Set(model.runs.filter((run) => run.activeCount > 0).map((run) => run.id)),
  );
  const [expandedAgentIds, setExpandedAgentIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        model.allAgents.filter((agent) => agent.parentAgentId === null).map((agent) => agent.id),
      ),
  );
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (model.liveCount === 0) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [model.liveCount]);

  useEffect(() => {
    if (!focusedAgentIds || focusedAgentIds.length === 0) return;
    const focused = new Set(focusedAgentIds);
    const run = model.runs.find((candidate) =>
      candidate.agents.some((agent) => focused.has(agent.id)),
    );
    if (run) setExpandedRunIds((current) => new Set([...current, run.id]));
    const byId = new Map(model.allAgents.map((agent) => [agent.id, agent]));
    const ancestry = new Set<string>();
    for (const agentId of focusedAgentIds) {
      let current = byId.get(agentId);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        ancestry.add(current.id);
        current = current.parentAgentId === null ? undefined : byId.get(current.parentAgentId);
      }
    }
    if (ancestry.size > 0) {
      setExpandedAgentIds((current) => new Set([...current, ...ancestry]));
    }
  }, [focusedAgentIds, model.allAgents, model.runs]);

  useEffect(() => {
    if (!selectedAgentId) return;
    const selected = model.allAgents.find((agent) => agent.id === selectedAgentId);
    if (!selected) return;
    const ancestors: string[] = [];
    let current = selected;
    while (current.parentAgentId !== null) {
      ancestors.push(current.parentAgentId);
      const parent = model.allAgents.find((agent) => agent.id === current.parentAgentId);
      if (!parent) break;
      current = parent;
    }
    setExpandedAgentIds((expanded) => new Set([...expanded, ...ancestors]));
    const run = model.runs.find((candidate) =>
      candidate.agents.some((agent) => agent.id === selected.id),
    );
    if (run) setExpandedRunIds((expanded) => new Set([...expanded, run.id]));
  }, [model.allAgents, model.runs, selectedAgentId]);

  const items = useMemo(() => {
    const result: BrowserItem[] = [];
    for (const run of model.runs) {
      result.push({ kind: "run", key: `run:${run.id}`, run });
      if (!expandedRunIds.has(run.id)) continue;
      let previousCompressedDepth = -1;
      for (const row of flattenAgentConversationRun(run, expandedAgentIds)) {
        if (row.depth > 6 && row.depth !== previousCompressedDepth) {
          result.push({
            kind: "ancestors",
            key: `ancestors:${run.id}:${row.agent.id}`,
            count: row.depth - 6,
            agent: row.agent,
          });
          previousCompressedDepth = row.depth;
        }
        result.push({
          kind: "agent",
          key: `agent:${row.agent.id}`,
          runId: run.id,
          agent: row.agent,
          depth: row.depth,
          hasChildren: row.hasChildren,
        });
      }
    }
    return result;
  }, [expandedAgentIds, expandedRunIds, model.runs]);

  const handleAgentKeyDown = (item: AgentRowItem, event: KeyboardEvent<HTMLButtonElement>) => {
    const agentButtons = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-agent-row]") ?? [],
    );
    const index = agentButtons.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      agentButtons[index + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      agentButtons[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && item.hasChildren) {
      event.preventDefault();
      setExpandedAgentIds((current) => new Set([...current, item.agent.id]));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expandedAgentIds.has(item.agent.id)) {
        setExpandedAgentIds((current) => {
          const next = new Set(current);
          next.delete(item.agent.id);
          return next;
        });
      } else if (item.agent.parentAgentId) {
        rootRef.current
          ?.querySelector<HTMLButtonElement>(
            `[data-agent-row="${CSS.escape(item.agent.parentAgentId)}"]`,
          )
          ?.focus();
      }
    }
  };

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Runs and their direct or nested agents appear here.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col"
      role="tree"
      aria-label="Agent conversation tree"
    >
      <div className="min-h-0 flex-1">
        <LegendList<BrowserItem>
          data={items}
          keyExtractor={(item) => item.key}
          estimatedItemSize={64}
          drawDistance={640}
          recycleItems
          className="h-full overflow-x-hidden"
          renderItem={({ item }) => {
            if (item.kind === "run") {
              const open = expandedRunIds.has(item.run.id);
              return (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => {
                    setExpandedRunIds((current) => {
                      const next = new Set(current);
                      if (open) next.delete(item.run.id);
                      else next.add(item.run.id);
                      return next;
                    });
                  }}
                  className="flex h-10 w-full items-center gap-2 border-b border-border/40 px-2 text-left hover:bg-accent/35"
                >
                  {open ? (
                    <ChevronDown aria-hidden className="size-3.5" />
                  ) : (
                    <ChevronRight aria-hidden className="size-3.5" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {item.run.title}
                  </span>
                  <span className="font-mono text-[.65rem] text-muted-foreground">
                    {item.run.activeCount > 0
                      ? `${item.run.activeCount} active`
                      : `${item.run.settledCount} settled`}
                  </span>
                </button>
              );
            }
            if (item.kind === "ancestors") {
              return (
                <button
                  type="button"
                  onClick={() => onSelectAgent(item.agent)}
                  className="flex h-7 w-full items-center gap-1 pl-[72px] text-left text-[.7rem] text-muted-foreground hover:bg-accent/35 hover:text-foreground"
                  aria-label={`Reveal ${item.count} ancestors for ${formatSubagentDisplayLabel(item.agent)} in the conversation breadcrumb`}
                >
                  <ChevronRight aria-hidden className="size-3" />… {item.count} ancestors · reveal
                  full breadcrumb
                </button>
              );
            }
            return (
              <AgentTreeRow
                item={item}
                selected={selectedAgentId === item.agent.id}
                expanded={expandedAgentIds.has(item.agent.id)}
                now={now}
                onToggle={() => {
                  setExpandedAgentIds((current) => {
                    const next = new Set(current);
                    if (next.has(item.agent.id)) next.delete(item.agent.id);
                    else next.add(item.agent.id);
                    return next;
                  });
                }}
                onSelect={() => onSelectAgent(item.agent)}
                onKeyDown={(event) => handleAgentKeyDown(item, event)}
              />
            );
          }}
        />
      </div>
      <footer className="flex h-8 items-center justify-between border-t border-border/60 px-3 font-mono text-[.7rem] text-muted-foreground">
        <span>
          {model.runningCount > 0 ? `${model.runningCount} running` : null}
          {model.waitingCount > 0 ? ` · ${model.waitingCount} waiting` : null}
          {model.idleCount > 0 ? ` · ${model.idleCount} idle` : null}
          {model.settledCount > 0 ? ` · ${model.settledCount} settled` : null}
        </span>
        {model.totalTokens > 0 ? (
          <span>Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
        ) : null}
      </footer>
    </div>
  );
}
