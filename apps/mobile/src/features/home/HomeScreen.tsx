import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { EmptyState } from "../../components/EmptyState";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadSearch } from "../../state/queries";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  ThreadListV2PendingRow,
  ThreadListV2ProjectRow,
  ThreadListV2Row,
  ThreadListV2SettledDock,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import {
  buildProjectThreadListV2,
  buildProjectThreadListV2ListItems,
  resolveSettledDockRows,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2Item,
  type ThreadListV2ProjectListItem,
} from "../threads/threadListV2";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onAddConnection: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onMovePinnedThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header (AndroidHomeHeader) is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const accentColor = useThemeColor("--color-icon-muted");
  const iosBottomToolbarClearance =
    Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED
      ? PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT
      : 0;
  const searchEnvironmentIds = useMemo(
    () =>
      props.selectedEnvironmentId === null
        ? props.environments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : props.environments.some(
              (environment) =>
                environment.environmentId === props.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [props.selectedEnvironmentId]
          : [],
    [props.environments, props.selectedEnvironmentId],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [props.projects]);

  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  // Logical project groups in group order — the per-project list model. The
  // web partition groups by the same buildProjectGroups output, so project
  // rows and thread nesting stay in sync across clients.
  const v2ProjectGroups = useMemo(
    () =>
      buildProjectGroups({
        projects: props.projects,
        settings: {
          sidebarProjectGroupingMode: props.projectGroupingMode,
          sidebarProjectGroupingOverrides: {},
        },
      }),
    [props.projectGroupingMode, props.projects],
  );
  const v2ScopedProjectGroup = useMemo(
    () =>
      v2ProjectScopeKey === null
        ? null
        : (v2ProjectGroups.find(
            (group) =>
              group.key === v2ProjectScopeKey ||
              group.memberProjectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  v2ProjectScopeKey,
              ),
          ) ?? null),
    [v2ProjectScopeKey, v2ProjectGroups],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        v2ProjectGroups.flatMap((group) =>
          group.memberProjectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                group.label,
              ] as const,
          ),
        ),
      ),
    [v2ProjectGroups],
  );
  const v2ScopedProjectKeys = useMemo(
    () =>
      v2ScopedProjectGroup === null
        ? null
        : new Set(
            v2ScopedProjectGroup.memberProjectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [v2ScopedProjectGroup],
  );
  // Per-project list model (pivot-22): pinned + active threads nest under
  // their logical project row; snoozed stays a global shelf; settled lives in
  // the fixed dock below the scroll area. Settled threads stay in the live
  // shell stream (settled ≠ archived), so the partition works directly off
  // live shells — no snapshot merging or optimistic holds.
  // PR states stream in per-row (rows own the VCS subscriptions); a merged or
  // closed PR auto-settles its thread on the next partition (mirrors web).
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, "open" | "closed" | "merged">
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: "open" | "closed" | "merged" | null) => {
      setChangeRequestStateByKey((current) => {
        if ((current.get(threadKey) ?? null) === state) return current;
        const next = new Map(current);
        if (state === null) {
          next.delete(threadKey);
        } else {
          next.set(threadKey, state);
        }
        return next;
      });
    },
    [],
  );
  const handleSettleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onSettleThread(thread);
    },
    [props.onSettleThread],
  );
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  const handleMovePinnedThread = useCallback(
    (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      void props.onMovePinnedThread(thread, direction);
    },
    [props.onMovePinnedThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${props.selectedEnvironmentId ?? "all"}:${v2ProjectScopeKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useState(false);
  const toggleSnoozedShelf = useCallback(() => setSnoozedShelfExpanded((value) => !value), []);
  const [settledShelfExpanded, setSettledShelfExpanded] = useState(true);
  const toggleSettledShelf = useCallback(() => setSettledShelfExpanded((value) => !value), []);
  // Per-project expansion persists as overrides keyed by logical projectKey
  // (the web sidebar's `t3code:sidebar-v2:project-expanded` map semantics;
  // mobile stores the map in the preferences blob). Local toggles layer on
  // top of whatever the store reported so a toggle never races the async load.
  const persistedProjectExpansion = useMemo(() => {
    const stored = AsyncResult.isSuccess(preferencesResult)
      ? (preferencesResult.value.sidebarProjectExpanded ?? {})
      : {};
    return stored;
  }, [preferencesResult]);
  const [projectExpansion, setProjectExpansion] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const effectiveProjectExpansion = useMemo(() => {
    const combined = new Map<string, boolean>();
    for (const [key, value] of Object.entries(persistedProjectExpansion)) {
      combined.set(key, value);
    }
    for (const [key, value] of projectExpansion) {
      combined.set(key, value);
    }
    return combined;
  }, [persistedProjectExpansion, projectExpansion]);
  // now is quantized to the minute and ticks so the inactivity auto-settle
  // boundary is actually crossed while the app stays open (mirrors web);
  // without a clock dependency the partition memoizes a frozen "now".
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    // Refresh immediately on mount: the mount-time value can be stale by the
    // time the list draws, which would misclassify the inactivity auto-settle
    // boundary until the first tick.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, []);
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  // Canonical arranged pinned order (reorder-capable threads only) for the
  // Move up/down position flags. Computed from all shells, not the rendered
  // list, so search/scope filtering never disables or misdirects a move.
  const arrangedPinnedKeys = useMemo(() => {
    const pinned = sortPinnedThreadsByOrderKey(
      props.threads.filter(
        (thread) =>
          thread.pinnedAt != null &&
          thread.archivedAt === null &&
          pinReorderEnvironmentIds.has(thread.environmentId),
      ),
    );
    return pinned.map((thread) => `${thread.environmentId}:${thread.id}`);
  }, [pinReorderEnvironmentIds, props.threads]);
  // Settled threads are live shells; archived threads keep their original
  // "hidden from lists" meaning.
  const projectThreadList = useMemo(
    () =>
      buildProjectThreadListV2({
        threads: props.threads.filter((thread) => thread.archivedAt === null),
        groups: v2ProjectGroups,
        expansion: effectiveProjectExpansion,
        environmentId: props.selectedEnvironmentId,
        projectRefs: v2ScopedProjectGroup === null ? null : v2ScopedProjectGroup.memberProjectRefs,
        searchQuery: props.searchQuery,
        matchedThreadKeys,
        changeRequestStateByKey,
        settlementEnvironmentIds,
        snoozeEnvironmentIds,
        now: `${nowMinute}:00.000Z`,
        snoozeNow: new Date().toISOString(),
      }),
    [
      changeRequestStateByKey,
      effectiveProjectExpansion,
      nowMinute,
      snoozeWakeTick,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threads,
      matchedThreadKeys,
      v2ProjectGroups,
      v2ScopedProjectGroup,
    ],
  );
  const toggleProject = useCallback(
    (projectKey: string) => {
      const project = projectThreadList.projects.find(
        (candidate) => candidate.group.key === projectKey,
      );
      const nextExpanded = !(project?.expanded ?? false);
      setProjectExpansion((current) => {
        const next = new Map(current);
        next.set(projectKey, nextExpanded);
        return next;
      });
      savePreferences({
        sidebarProjectExpanded: {
          ...persistedProjectExpansion,
          ...Object.fromEntries(projectExpansion),
          [projectKey]: nextExpanded,
        },
      });
    },
    [persistedProjectExpansion, projectExpansion, projectThreadList.projects, savePreferences],
  );
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = projectThreadList.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  // Queued tasks are not thread shells, so the v2 partition never sees them;
  // they are spliced in below the active block and stay visible and deletable
  // while their environment is offline. Same environment scope and search
  // filter as the list itself.
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = useMemo(
    () =>
      props.pendingTasks.filter(
        (pendingTask) =>
          (props.selectedEnvironmentId === null ||
            pendingTask.message.environmentId === props.selectedEnvironmentId) &&
          (v2ScopedProjectKeys === null ||
            v2ScopedProjectKeys.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            )) &&
          (v2SearchQuery.length === 0 ||
            pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
      ),
    [props.pendingTasks, props.selectedEnvironmentId, v2ScopedProjectKeys, v2SearchQuery],
  );
  const threadListV2Items = useMemo(
    () =>
      buildProjectThreadListV2ListItems({
        partition: projectThreadList,
        pendingTasks: v2PendingTasks,
        snoozedShelfExpanded,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
      }),
    [nowMinute, projectThreadList, snoozedShelfExpanded, v2PendingTasks],
  );
  // The settled dock lives below the scroll area and pages its own rows;
  // the compact Home list never pins a selected thread (navigation happens
  // on select).
  const settledDockRows = useMemo(
    () =>
      resolveSettledDockRows({
        settled: projectThreadList.settled,
        expanded: settledShelfExpanded,
        visibleCount: settledVisibleCount,
        selectedThreadKey: null,
      }),
    [projectThreadList.settled, settledShelfExpanded, settledVisibleCount],
  );

  // Shared row wiring for list rows and the settled dock: a slim dock row is
  // just a v2 thread item with variant slim and no trailing hairline.
  const renderV2ThreadRow = useCallback(
    (item: ThreadListV2Item, showTrailingDivider: boolean, snoozeWakeLabelText?: string) => {
      const thread = item.thread;
      return (
        <ThreadListV2Row
          thread={thread}
          variant={item.variant}
          snoozed={item.snoozed}
          pinned={item.pinned}
          snoozePresetMinute={nowMinute}
          snoozeWakeLabelText={snoozeWakeLabelText}
          showTrailingDivider={showTrailingDivider}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          projectTitle={v2ProjectTitleByProjectKey.get(
            scopedProjectKey(thread.environmentId, thread.projectId),
          )}
          providerDriver={
            serverConfigs
              .get(thread.environmentId)
              ?.providers.find(
                (provider) =>
                  provider.instanceId ===
                  (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
              )?.driver ?? null
          }
          environmentLabel={
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          onSelectThread={props.onSelectThread}
          onDeleteThread={handleDeleteThread}
          onArchiveThread={props.onArchiveThread}
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={handleSettleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          pinReorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
          canMovePinnedUp={arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`) > 0}
          canMovePinnedDown={(() => {
            const index = arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`);
            return index !== -1 && index < arrangedPinnedKeys.length - 1;
          })()}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onMovePinnedThread={handleMovePinnedThread}
          onChangeRequestState={handleChangeRequestState}
          projectCwd={
            projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
        />
      );
    },
    [
      handleChangeRequestState,
      handleDeleteThread,
      arrangedPinnedKeys,
      handleMovePinnedThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      pinningEnvironmentIds,
      pinReorderEnvironmentIds,
      projectByKey,
      projectCwdByKey,
      props.onArchiveThread,
      props.onSelectThread,
      props.savedConnectionsById,
      props.searchQuery,
      serverConfigs,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      v2ProjectTitleByProjectKey,
      nowMinute,
    ],
  );
  const renderV2Item = useCallback(
    ({ item, index }: { readonly item: ThreadListV2ProjectListItem; readonly index: number }) => {
      const nextItem = threadListV2Items[index + 1];
      const showTrailingDivider =
        nextItem?.type === "v2-thread" ||
        (nextItem?.type === "v2-pending" && !nextItem.showPendingDivider);
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.message.environmentId,
          item.pendingTask.creation.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.message.environmentId]
                    ?.environmentLabel ?? null)
                : null
            }
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-project") {
        return (
          <ThreadListV2ProjectRow
            project={item.project}
            expanded={item.expanded}
            isFirstProject={item.isFirstProject}
            onToggle={toggleProject}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      return renderV2ThreadRow(item.item, showTrailingDivider, item.snoozeWakeLabelText);
    },
    [
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      props.savedConnectionsById,
      renderV2ThreadRow,
      threadListV2Items,
      toggleProject,
      toggleSnoozedShelf,
      v2ProjectTitleByProjectKey,
    ],
  );
  const v2KeyExtractor = useCallback((item: ThreadListV2ProjectListItem) => item.key, []);
  // Settled rows render in the fixed dock below the scroll area; the dock
  // draws its own chrome and paging, so rows never carry a trailing hairline.
  const renderSettledRow = useCallback(
    (thread: EnvironmentThreadShell) =>
      renderV2ThreadRow(
        { thread, variant: "slim", snoozed: false, pinned: false, isLast: false },
        false,
      ),
    [renderV2ThreadRow],
  );

  // FlatList treats a changed extraData identity as "re-render every visible
  // row", so an inline object literal would invalidate all rows on every
  // HomeScreen render.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      serverConfigs,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      projectByKey,
      projectCwdByKey,
      props.searchQuery,
      props.savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
      v2ProjectTitleByProjectKey,
    ],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so the same check covers the list.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    return (
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
        style={{
          paddingBottom: Math.max(insets.bottom, 24) + iosBottomToolbarClearance,
          paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
        }}
      >
        <View className="w-full max-w-[430px]">
          <EmptyState
            title={emptyState.title}
            detail={emptyState.detail}
            actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
            onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
            variant="plain"
          />
          {emptyState.loading ? (
            <View className="mt-4 items-center">
              <ActivityIndicator color={accentColor} />
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  const hasSearchQuery = props.searchQuery.trim().length > 0;
  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface). Android's custom header
  // renders in-flow above this screen, so the list only needs breathing room.
  const listHeader = Platform.OS === "ios" ? null : <HomeTopContentSpacer />;
  // Snoozed threads need no special empty state: their shelf header is a list
  // row even while collapsed.
  const listEmpty =
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.label}`}
        detail="Choose another project or create a new task."
      />
    ) : (
      <EmptyState title="No threads yet" detail="Create a task to start a new coding session." />
    );

  return (
    <View className="flex-1 bg-screen">
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        {/* The scroll list ends above the dock; the dock is a fixed sibling
            below it, so expanding the dock shrinks the list viewport (the
            dock "expands upward"). */}
        <FlatList
          data={threadListV2Items}
          renderItem={renderV2Item}
          keyExtractor={v2KeyExtractor}
          extraData={v2ExtraData}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          scrollEventThrottle={16}
          contentContainerStyle={{ paddingBottom: 12 }}
        />
        <ThreadListV2SettledDock
          count={projectThreadList.settled.length}
          rows={settledDockRows.rows}
          hiddenCount={settledDockRows.hiddenCount}
          expanded={settledShelfExpanded}
          onToggle={toggleSettledShelf}
          onShowMore={showMoreSettled}
          renderRow={renderSettledRow}
          bottomPadding={
            Platform.OS === "ios"
              ? Math.max(insets.bottom, 12) + 12 + iosBottomToolbarClearance
              : Math.max(insets.bottom, 16) + 88
          }
        />
      </SwipeableScrollGateProvider>
    </View>
  );
}
