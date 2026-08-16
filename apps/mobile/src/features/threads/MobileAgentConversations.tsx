import {
  agentConversationBreadcrumb,
  flattenAgentConversationRun,
  formatSubagentDisplayLabel,
  type AgentConversationRun,
  type AgentConversationTreeRow,
  type AgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ServerOmpAgentChatEntry, ThreadId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobileAgentTreeIndent } from "./mobileAgentConversationLayout";
import { ThreadMarkdownText } from "./ThreadFeed";

const DEFAULT_READ_ONLY_REASON =
  "This OMP version does not expose agent-targeted messaging over RPC.";

function statusLabel(agent: RuntimeSubagent): string {
  if (agent.assignmentStatus === "queued") return "Queued";
  if (agent.activityStatus === "rate_limited") return "Rate limited";
  if (agent.activityStatus === "retrying") return "Retrying";
  if (agent.status === "waiting") return "Waiting";
  if (agent.status === "running") return "Working";
  if (agent.status === "idle") return "Idle · resumable";
  if (agent.status === "completed") return "Completed";
  if (agent.status === "failed") return "Failed";
  if (agent.status === "cancelled") return "Cancelled";
  if (agent.status === "interrupted") return "Interrupted";
  return "Pending";
}
function statusSymbol(agent: RuntimeSubagent): AppSymbolName {
  if (agent.status === "failed" || agent.status === "interrupted") {
    return "exclamationmark.triangle";
  }
  if (agent.status === "completed") return "checkmark.circle";
  if (agent.status === "waiting") return "pause.circle";
  if (agent.status === "idle") return "moon";
  return "circle.fill";
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
function RunRow(props: { readonly run: AgentConversationRun; readonly onPress: () => void }) {
  const iconColor = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.run.title}`}
      className="mx-4 min-h-16 flex-row items-center gap-3 border-b border-border py-3"
      onPress={props.onPress}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-subtle">
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={16}
          tintColor={iconColor}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
          {props.run.title}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {props.run.agents.length} agents · {props.run.activeCount} active ·{" "}
          {props.run.settledCount} settled
        </Text>
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

function AgentTreeRow(props: {
  readonly row: AgentConversationTreeRow;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const { hiddenAncestors, indentation } = mobileAgentTreeIndent(props.row.depth);
  const label = formatSubagentDisplayLabel(props.row.agent);
  return (
    <View style={{ paddingLeft: indentation }}>
      {hiddenAncestors > 0 ? (
        <Text className="ml-4 pt-1 text-[11px] text-muted-foreground">
          … {hiddenAncestors} ancestors · full path in chat
        </Text>
      ) : null}
      <View className="mx-4 min-h-16 flex-row items-center border-b border-border">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.expanded ? "Collapse child agents" : "Expand child agents"}
          className="h-11 w-8 items-center justify-center"
          disabled={!props.row.hasChildren}
          onPress={props.onToggle}
        >
          {props.row.hasChildren ? (
            <SymbolView
              name={props.expanded ? "chevron.down" : "chevron.right"}
              size={12}
              tintColor={iconColor}
              type="monochrome"
            />
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${label} conversation`}
          className="min-w-0 flex-1 flex-row items-center gap-2 py-2"
          onPress={props.onOpen}
        >
          <SymbolView
            name={statusSymbol(props.row.agent)}
            size={13}
            tintColor={iconColor}
            type="monochrome"
          />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
              {label}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {statusLabel(props.row.agent)}
              {props.row.agent.progress ? ` · ${props.row.agent.progress}` : ""}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function AgentTranscript(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly model: AgentPanelModel;
  readonly agent: RuntimeSubagent;
  readonly onBack: () => void;
  readonly onSelectMain: () => void;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const label = formatSubagentDisplayLabel(props.agent);
  const getMessages = useAtomCommand(serverEnvironment.ompGetSubagentMessages, {
    reportFailure: false,
  });
  const setSubscription = useAtomCommand(serverEnvironment.ompSetSubagentSubscription, {
    reportFailure: false,
  });
  const [entries, setEntries] = useState<ReadonlyArray<ServerOmpAgentChatEntry>>([]);
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readOnlyReason, setReadOnlyReason] = useState(
    props.agent.capabilities.readOnlyReason ?? DEFAULT_READ_ONLY_REASON,
  );
  const cursorRef = useRef(0);
  const inFlightRef = useRef(false);

  const load = useCallback(
    async (fromByte: number, replace: boolean) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const result = await getMessages({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, subagentId: props.agent.id, fromByte },
      });
      inFlightRef.current = false;
      if (result._tag === "Failure") {
        setError("Could not load this agent conversation.");
        setLoading(false);
        return;
      }
      const page = result.value;
      setReadOnlyReason(page.capabilities.readOnlyReason ?? DEFAULT_READ_ONLY_REASON);
      setEntries((current) => {
        if (replace || page.reset) return page.entries;
        const known = new Set(current.map((entry) => entry.id));
        return [...current, ...page.entries.filter((entry) => !known.has(entry.id))];
      });
      cursorRef.current = page.nextByte;
      setError(null);
      setLoading(false);
    },
    [getMessages, props.agent.id, props.environmentId, props.threadId],
  );

  useEffect(() => {
    let cancelled = false;
    cursorRef.current = 0;
    setEntries([]);
    setLoading(true);
    setError(null);
    setExpandedToolIds(new Set());
    setReadOnlyReason(props.agent.capabilities.readOnlyReason ?? DEFAULT_READ_ONLY_REASON);
    void (async () => {
      await setSubscription({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, level: "events" },
      });
      if (!cancelled) await load(0, true);
    })();
    return () => {
      cancelled = true;
      void setSubscription({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, level: "progress" },
      });
    };
  }, [load, props.agent.id, props.environmentId, props.threadId, setSubscription]);

  useEffect(() => {
    if (!loading) void load(cursorRef.current, false);
  }, [load, loading, props.agent.completedAt, props.agent.transcriptRevision]);

  const breadcrumb = agentConversationBreadcrumb(props.model.allAgents, props.agent.id);
  const terminalSummary = props.agent.error ?? props.agent.result;

  const renderEntry = useCallback(
    ({ item }: { item: ServerOmpAgentChatEntry }) => {
      if (item.kind === "tool") {
        const expanded = expandedToolIds.has(item.id);
        const detail = [
          item.toolInput === undefined ? "" : `Input\n${serializeToolDetail(item.toolInput)}`,
          item.toolOutput === undefined ? "" : `Output\n${serializeToolDetail(item.toolOutput)}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            className="mx-4 my-1 rounded-xl border border-border bg-card px-3 py-2"
            onPress={() => {
              setExpandedToolIds((current) => {
                const next = new Set(current);
                if (expanded) next.delete(item.id);
                else next.add(item.id);
                return next;
              });
            }}
          >
            <View className="flex-row items-center gap-2">
              <SymbolView
                name="wrench.and.screwdriver"
                size={13}
                tintColor={iconColor}
                type="monochrome"
              />
              <Text
                className="min-w-0 flex-1 text-xs font-t3-bold text-foreground"
                numberOfLines={1}
              >
                Tool · {item.toolName ?? "activity"}
                {item.text ? ` · ${item.text}` : ""}
              </Text>
              <SymbolView
                name={expanded ? "chevron.down" : "chevron.right"}
                size={11}
                tintColor={iconColor}
                type="monochrome"
              />
            </View>
            {expanded && detail ? (
              <Text
                selectable
                className="mt-2 border-t border-border pt-2 font-mono text-xs text-foreground"
              >
                {detail}
              </Text>
            ) : null}
          </Pressable>
        );
      }

      return (
        <View className="mx-4 my-2">
          <Text className="mb-1 text-[11px] font-t3-bold text-muted-foreground">
            {item.role === "assistant" ? label : item.role}
          </Text>
          <ThreadMarkdownText text={item.text} />
        </View>
      );
    },
    [expandedToolIds, iconColor, label],
  );

  return (
    <View className="flex-1 bg-screen">
      <View className="border-b border-border bg-screen px-4 pb-2 pt-2">
        <View className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to agent run"
            className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
            onPress={props.onBack}
          >
            <SymbolView name="chevron.left" size={15} tintColor={iconColor} type="monochrome" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
              {label}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {statusLabel(props.agent)} · read-only
            </Text>
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-2">
          <Pressable onPress={props.onSelectMain} className="py-1 pr-2">
            <Text className="text-xs text-muted-foreground">Main</Text>
          </Pressable>
          {breadcrumb.map((agent) => (
            <View key={agent.id} className="flex-row items-center">
              <Text className="text-xs text-muted-foreground">›</Text>
              <Pressable onPress={() => props.onSelectAgent(agent.id)} className="px-2 py-1">
                <Text
                  className={
                    agent.id === props.agent.id
                      ? "text-xs font-t3-bold text-foreground"
                      : "text-xs text-muted-foreground"
                  }
                  numberOfLines={1}
                >
                  {formatSubagentDisplayLabel(agent)}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      </View>

      {terminalSummary ? (
        <View
          className={
            props.agent.error
              ? "mx-4 mt-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3"
              : "mx-4 mt-3 rounded-xl border border-border bg-card p-3"
          }
        >
          <Text className="text-xs font-t3-bold text-foreground">
            {props.agent.error ? "Agent error" : "Agent result"}
          </Text>
          <Text selectable className="mt-1 text-sm text-foreground">
            {terminalSummary}
          </Text>
        </View>
      ) : null}

      {loading ? (
        <View className="flex-1 items-center justify-center gap-3">
          <ActivityIndicator />
          <Text className="text-sm text-muted-foreground">Loading agent conversation…</Text>
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-muted-foreground">{error}</Text>
        </View>
      ) : (
        <LegendList
          className="flex-1"
          data={entries}
          estimatedItemSize={96}
          keyExtractor={(entry) => entry.id}
          renderItem={renderEntry}
          recycleItems
          contentContainerStyle={{ paddingBottom: 20, paddingTop: 8 }}
          ListEmptyComponent={
            <View className="items-center px-8 py-16">
              <Text className="text-center text-sm text-muted-foreground">
                No transcript entries are available for this agent yet.
              </Text>
            </View>
          }
        />
      )}

      <View className="border-t border-border bg-card px-4 py-3">
        <Text className="text-xs text-muted-foreground">Read-only · {readOnlyReason}</Text>
      </View>
    </View>
  );
}

export interface MobileAgentConversationNavigationState {
  readonly selectedRunId: string | null;
  readonly selectedAgentId: string | null;
}

export function MobileAgentConversations(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly model: AgentPanelModel;
  readonly navigationState: MobileAgentConversationNavigationState;
  readonly onNavigationStateChange: (state: MobileAgentConversationNavigationState) => void;
  readonly onClose: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const { selectedRunId, selectedAgentId } = props.navigationState;
  const [expandedAgentIds, setExpandedAgentIds] = useState<ReadonlySet<string>>(
    () => new Set(props.model.allAgents.map((agent) => agent.id)),
  );

  useEffect(() => {
    setExpandedAgentIds((current) => {
      const next = new Set(current);
      props.model.allAgents.forEach((agent) => next.add(agent.id));
      return next;
    });
  }, [props.model.allAgents]);

  const selectedAgent =
    selectedAgentId === null
      ? null
      : (props.model.allAgents.find((agent) => agent.id === selectedAgentId) ?? null);
  const selectedRun =
    selectedRunId === null
      ? null
      : (props.model.runs.find((run) => run.id === selectedRunId) ?? null);
  const rows = useMemo(
    () => (selectedRun === null ? [] : flattenAgentConversationRun(selectedRun, expandedAgentIds)),
    [expandedAgentIds, selectedRun],
  );

  if (selectedAgent !== null) {
    return (
      <AgentTranscript
        environmentId={props.environmentId}
        threadId={props.threadId}
        model={props.model}
        agent={selectedAgent}
        onBack={() =>
          props.onNavigationStateChange({
            selectedRunId,
            selectedAgentId: null,
          })
        }
        onSelectMain={props.onClose}
        onSelectAgent={(nextAgentId) =>
          props.onNavigationStateChange({
            selectedRunId,
            selectedAgentId: nextAgentId,
          })
        }
      />
    );
  }

  if (selectedRun !== null) {
    return (
      <View className="flex-1 bg-screen">
        <View className="min-h-14 flex-row items-center gap-2 border-b border-border px-4 py-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to agent runs"
            className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
            onPress={() =>
              props.onNavigationStateChange({
                selectedRunId: null,
                selectedAgentId: null,
              })
            }
          >
            <SymbolView name="chevron.left" size={15} tintColor={iconColor} type="monochrome" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
              {selectedRun.title}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {selectedRun.agents.length} agents · tap an agent to open its chat
            </Text>
          </View>
        </View>
        <LegendList
          className="flex-1"
          data={rows}
          estimatedItemSize={64}
          extraData={expandedAgentIds}
          keyExtractor={(row) => row.agent.id}
          renderItem={({ item }) => (
            <AgentTreeRow
              row={item}
              expanded={expandedAgentIds.has(item.agent.id)}
              onToggle={() => {
                setExpandedAgentIds((current) => {
                  const next = new Set(current);
                  if (next.has(item.agent.id)) next.delete(item.agent.id);
                  else next.add(item.agent.id);
                  return next;
                });
              }}
              onOpen={() =>
                props.onNavigationStateChange({
                  selectedRunId,
                  selectedAgentId: item.agent.id,
                })
              }
            />
          )}
          recycleItems
          contentContainerStyle={{ paddingBottom: 20 }}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      <View className="min-h-14 flex-row items-center gap-2 border-b border-border px-4 py-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to main conversation"
          className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
          onPress={props.onClose}
        >
          <SymbolView name="chevron.left" size={15} tintColor={iconColor} type="monochrome" />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-bold text-foreground">Agent runs</Text>
          <Text className="text-xs text-muted-foreground">
            {props.model.allAgents.length} conversations · {props.model.liveCount} live
          </Text>
        </View>
      </View>
      <LegendList
        className="flex-1"
        data={props.model.runs}
        estimatedItemSize={64}
        keyExtractor={(run) => run.id}
        renderItem={({ item }) => (
          <RunRow
            run={item}
            onPress={() =>
              props.onNavigationStateChange({
                selectedRunId: item.id,
                selectedAgentId: null,
              })
            }
          />
        )}
        recycleItems
        contentContainerStyle={{ paddingBottom: 20 }}
        ListEmptyComponent={
          <View className="items-center px-8 py-16">
            <Text className="text-center text-sm text-muted-foreground">
              This thread has no agent conversations.
            </Text>
          </View>
        }
      />
    </View>
  );
}
