import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  agentConversationBreadcrumb,
  formatSubagentDisplayLabel,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ServerOmpAgentChatEntry, ThreadId } from "@t3tools/contracts";
import { ChevronRight, Copy, Search, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

const DEFAULT_READ_ONLY_REASON =
  "This OMP version does not expose agent-targeted messaging over RPC.";

export function mergeAgentTranscriptEntries(
  current: ReadonlyArray<ServerOmpAgentChatEntry>,
  incoming: ReadonlyArray<ServerOmpAgentChatEntry>,
  replace: boolean,
): ReadonlyArray<ServerOmpAgentChatEntry> {
  if (replace) return incoming;
  const known = new Set(current.map((entry) => entry.id));
  return [...current, ...incoming.filter((entry) => !known.has(entry.id))];
}

function serializeToolDetail(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function AgentToolEntry({
  entry,
  expanded,
  onExpandedChange,
}: {
  entry: ServerOmpAgentChatEntry;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const detail = [
    entry.toolInput === undefined ? "" : `Input\n${serializeToolDetail(entry.toolInput)}`,
    entry.toolOutput === undefined ? "" : `Output\n${serializeToolDetail(entry.toolOutput)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/40",
        entry.isError ? "border-destructive/50" : "border-border/60",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Wrench aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Tool · {entry.toolName ?? "activity"}</span>
        {entry.text ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {entry.text}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && detail ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 p-3 font-mono text-xs leading-relaxed">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

export function AgentChatView({
  environmentId,
  threadId,
  model,
  agent,
  markdownCwd,
  onSelectMain,
  onSelectAgent,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  model: AgentPanelModel;
  agent: RuntimeSubagent;
  markdownCwd?: string;
  onSelectMain: () => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const getMessages = useAtomCommand(serverEnvironment.ompGetSubagentMessages, {
    reportFailure: false,
  });
  const setSubscription = useAtomCommand(serverEnvironment.ompSetSubagentSubscription, {
    reportFailure: false,
  });
  const [entries, setEntries] = useState<ReadonlyArray<ServerOmpAgentChatEntry>>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [readOnlyReason, setReadOnlyReason] = useState(
    agent.capabilities.readOnlyReason ?? DEFAULT_READ_ONLY_REASON,
  );
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(() => new Set());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);
  const inFlightRef = useRef(false);
  const [hasUnread, setHasUnread] = useState(false);
  const agentKey = `${environmentId}:${threadId}:${agent.id}`;

  const load = useCallback(
    async (fromByte: number, replace: boolean, follow: boolean) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const result = await getMessages({
        environmentId,
        input: { threadId, subagentId: agent.id, fromByte },
      });
      inFlightRef.current = false;
      if (result._tag === "Failure") {
        setError("Could not load this agent conversation.");
        setLoading(false);
        return;
      }
      const page = result.value;
      setReadOnlyReason(page.capabilities.readOnlyReason ?? DEFAULT_READ_ONLY_REASON);
      setEntries((current) =>
        mergeAgentTranscriptEntries(current, page.entries, replace || page.reset),
      );
      cursorRef.current = page.nextByte;
      setCursor(page.nextByte);
      setError(null);
      setLoading(false);
      const readCursor = Number(sessionStorage.getItem(`pivot:agent-read-byte:${agentKey}`) ?? "0");
      if (page.nextByte > readCursor && !follow) setHasUnread(true);
      if (follow) {
        requestAnimationFrame(() => {
          if (scrollerRef.current) {
            scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
          }
          sessionStorage.setItem(`pivot:agent-read-byte:${agentKey}`, String(page.nextByte));
          setHasUnread(false);
        });
      }
    },
    [agent.id, agentKey, environmentId, getMessages, threadId],
  );

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setCursor(0);
    cursorRef.current = 0;
    setLoading(true);
    setHasUnread(false);
    setError(null);
    setReadOnlyReason(agent.capabilities.readOnlyReason ?? DEFAULT_READ_ONLY_REASON);
    const storedExpanded = sessionStorage.getItem(`pivot:agent-tools:${agentKey}`);
    if (storedExpanded) {
      try {
        const ids = JSON.parse(storedExpanded) as unknown;
        setExpandedToolIds(
          new Set(
            Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
          ),
        );
      } catch {
        setExpandedToolIds(new Set());
      }
    } else {
      setExpandedToolIds(new Set());
    }
    void (async () => {
      await setSubscription({
        environmentId,
        input: { threadId, level: "events" },
      });
      if (!cancelled) await load(0, true, false);
      if (!cancelled) {
        requestAnimationFrame(() => {
          const saved = sessionStorage.getItem(`pivot:agent-scroll:${agentKey}`);
          const scroller = scrollerRef.current;
          if (!scroller) return;
          if (saved === null) {
            scroller.scrollTop = scroller.scrollHeight;
            sessionStorage.setItem(`pivot:agent-read-byte:${agentKey}`, String(cursorRef.current));
            setHasUnread(false);
            return;
          }
          const savedScrollTop = Number(saved);
          if (Number.isFinite(savedScrollTop)) scroller.scrollTop = savedScrollTop;
        });
      }
    })();
    return () => {
      cancelled = true;
      if (scrollerRef.current) {
        sessionStorage.setItem(
          `pivot:agent-scroll:${agentKey}`,
          String(scrollerRef.current.scrollTop),
        );
      }
      void setSubscription({
        environmentId,
        input: { threadId, level: "progress" },
      });
    };
  }, [agent.id, agentKey, environmentId, load, setSubscription, threadId]);

  useEffect(() => {
    if (loading) return;
    const scroller = scrollerRef.current;
    const followsEnd =
      scroller !== null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    void load(cursorRef.current, false, followsEnd);
  }, [agent.completedAt, agent.transcriptRevision, cursor, load, loading]);

  useEffect(() => {
    sessionStorage.setItem(
      `pivot:agent-tools:${agentKey}`,
      JSON.stringify(Array.from(expandedToolIds)),
    );
  }, [agentKey, expandedToolIds]);

  const markReadIfAtEnd = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 48) {
      return;
    }
    sessionStorage.setItem(`pivot:agent-read-byte:${agentKey}`, String(cursorRef.current));
    setHasUnread(false);
  }, [agentKey]);

  const breadcrumb = agentConversationBreadcrumb(model.allAgents, agent.id);
  const label = formatSubagentDisplayLabel(agent);
  const taskDetail =
    agent.title !== label
      ? agent.title
      : (agent.progress ?? agent.result ?? agent.error ?? agent.role ?? agent.id);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = useMemo(
    () =>
      normalizedQuery.length === 0
        ? entries
        : entries.filter((entry) => {
            const haystack = `${entry.role} ${entry.toolName ?? ""} ${entry.text} ${serializeToolDetail(entry.toolInput)} ${serializeToolDetail(entry.toolOutput)}`;
            return haystack.toLocaleLowerCase().includes(normalizedQuery);
          }),
    [entries, normalizedQuery],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label={`${label} chat`}>
      <header className="border-b border-border/60 px-4 py-2">
        <nav
          aria-label="Agent conversation breadcrumb"
          className="flex min-w-0 items-center gap-1 text-xs"
        >
          <button
            type="button"
            onClick={onSelectMain}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            Main
          </button>
          {breadcrumb.map((ancestor) => (
            <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
              <button
                type="button"
                onClick={() => onSelectAgent(ancestor.id)}
                className={cn(
                  "min-w-0 truncate",
                  ancestor.id === agent.id
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {formatSubagentDisplayLabel(ancestor)}
              </button>
            </span>
          ))}
        </nav>
        <div className="mt-1 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{label}</h2>
            <p className="truncate text-xs text-muted-foreground">{taskDetail}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasUnread ? (
              <button
                type="button"
                className="rounded-full bg-info/15 px-2 py-0.5 text-xs text-info"
                onClick={() => {
                  if (scrollerRef.current) {
                    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
                  }
                  sessionStorage.setItem(
                    `pivot:agent-read-byte:${agentKey}`,
                    String(cursorRef.current),
                  );
                  setHasUnread(false);
                }}
              >
                New activity
              </button>
            ) : null}
            <span className="font-mono text-xs text-muted-foreground">
              {agent.assignmentStatus === "queued"
                ? "Queued"
                : agent.status === "waiting"
                  ? "Waiting"
                  : agent.status === "running"
                    ? "Working"
                    : agent.status === "idle"
                      ? "Idle · resumable"
                      : agent.status}
            </span>
          </div>
        </div>
        <label className="mt-2 flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
          <Search aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="sr-only">Search agent conversation</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this agent chat"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
      </header>

      <div
        ref={scrollerRef}
        onScroll={markReadIfAtEnd}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {loading ? <p className="text-sm text-muted-foreground">Loading conversation…</p> : null}
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          {!loading && !error && visibleEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {entries.length === 0
                ? "No conversation entries yet."
                : "No entries match this search."}
            </p>
          ) : null}
          {visibleEntries.map((entry) =>
            entry.kind === "tool" ? (
              <AgentToolEntry
                key={entry.id}
                entry={entry}
                expanded={expandedToolIds.has(entry.id)}
                onExpandedChange={(expanded) => {
                  setExpandedToolIds((current) => {
                    const next = new Set(current);
                    if (expanded) next.add(entry.id);
                    else next.delete(entry.id);
                    return next;
                  });
                }}
              />
            ) : (
              <article
                key={entry.id}
                className={cn(
                  "group rounded-lg border border-border/50 px-4 py-3",
                  entry.role === "user" ? "ml-auto max-w-[85%] bg-accent/45" : "bg-card/25",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-[.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                  <span>{entry.role}</span>
                  <button
                    type="button"
                    aria-label="Copy message"
                    className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    onClick={() => void navigator.clipboard.writeText(entry.text)}
                  >
                    <Copy aria-hidden className="size-3" />
                  </button>
                </div>
                <ChatMarkdown
                  text={entry.text}
                  cwd={markdownCwd}
                  lineBreaks={entry.role === "user"}
                />
              </article>
            ),
          )}
        </div>
      </div>

      <footer className="border-t border-border/60 px-4 py-3">
        <div className="mx-auto max-w-3xl rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          Read-only · {readOnlyReason}
        </div>
      </footer>
    </section>
  );
}
