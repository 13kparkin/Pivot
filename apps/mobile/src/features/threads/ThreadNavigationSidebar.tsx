import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Platform, Pressable, StyleSheet, TextInput, View, useColorScheme } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import {
  ThreadListV2PendingRow,
  ThreadListV2ProjectRow,
  ThreadListV2Row,
  ThreadListV2SettledDock,
  ThreadListV2SnoozedShelfHeader,
} from "./thread-list-v2-items";
import {
  buildProjectThreadListV2,
  buildProjectThreadListV2ListItems,
  resolveSettledDockRows,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2Item,
  type ThreadListV2ProjectListItem,
} from "./threadListV2";

/** The sidebar list: per-project rows with nested thread cards plus the
    global snoozed shelf. Settled lives in the fixed dock below the list. */
type SidebarListItem = ThreadListV2ProjectListItem;

/**
 * Shared capsule behind the sidebar header buttons — a native liquid-glass
 * surface on iOS 26+, a tinted pill everywhere else.
 */
function SidebarHeaderButtonGroup(props: {
  readonly children: ReactNode;
  readonly colorScheme: "light" | "dark";
}) {
  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        colorScheme={props.colorScheme}
        effect="regular"
        interactive
        style={styles.headerButtonGroup}
      >
        {props.children}
      </LiquidGlassView>
    );
  }

  return (
    <View
      style={[
        styles.headerButtonGroup,
        props.colorScheme === "dark"
          ? { backgroundColor: "rgba(118,118,128,0.24)", borderColor: "rgba(255,255,255,0.08)" }
          : { backgroundColor: "rgba(255,255,255,0.72)", borderColor: "rgba(0,0,0,0.08)" },
        { borderWidth: StyleSheet.hairlineWidth },
      ]}
    >
      {props.children}
    </View>
  );
}

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;
const SIDEBAR_STICKY_HEADER_FADE_HEIGHT = 44;
const SIDEBAR_HEADER_WASH_OPACITY = {
  dark: [0.22, 0.14, 0.04],
  light: [0.46, 0.3, 0.08],
} as const;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1"
      style={{
        width: props.width,
        backgroundColor,
        borderRightColor: borderColor,
        borderRightWidth: StyleSheet.hairlineWidth,
      }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [headerIsOverContent, setHeaderIsOverContent] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const headerIsOverContentRef = useRef(false);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    movePinnedThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options, setSelectedEnvironmentId } = useHomeListOptions(availableEnvironmentIds);
  const searchEnvironmentIds = useMemo(
    () =>
      options.selectedEnvironmentId === null
        ? workspaceEnvironments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : workspaceEnvironments.some(
              (environment) =>
                environment.environmentId === options.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [options.selectedEnvironmentId]
          : [],
    [options.selectedEnvironmentId, workspaceEnvironments],
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
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  // Logical project groups in group order — the per-project list model (the
  // web sidebar partitions the same shared buildProjectGroups output).
  const v2ProjectGroups = useMemo(
    () =>
      buildProjectGroups({
        projects,
        settings: {
          sidebarProjectGroupingMode: options.projectGroupingMode,
          sidebarProjectGroupingOverrides: {},
        },
      }),
    [options.projectGroupingMode, projects],
  );
  const projectFilterOptions = useMemo(
    () =>
      v2ProjectGroups
        .filter(
          (group) =>
            options.selectedEnvironmentId === null ||
            group.memberProjectRefs.some(
              (projectRef) => projectRef.environmentId === options.selectedEnvironmentId,
            ),
        )
        .map((group) => ({
          key: group.key,
          label: group.label,
        })),
    [options.selectedEnvironmentId, v2ProjectGroups],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [projects]);
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  // Thread List v2 (beta) support — same model as the compact Home list
  // (HomeScreen.tsx): flat creation-order card block + settled recency tail.
  // PR states stream in per-row; merged/closed PRs auto-settle their thread
  // on the next partition.
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
  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
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
  // now ticks per minute so the inactivity auto-settle boundary is actually
  // crossed while the pane stays open; without a clock dependency the
  // partition memoizes a frozen "now".
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
  // Canonical arranged pinned order for Move up/down flags — computed from
  // all shells so search/scope filtering never disables a valid move.
  const arrangedPinnedKeys = useMemo(() => {
    const pinned = sortPinnedThreadsByOrderKey(
      threads.filter(
        (thread) =>
          thread.pinnedAt != null &&
          thread.archivedAt === null &&
          pinReorderEnvironmentIds.has(thread.environmentId),
      ),
    );
    return pinned.map((thread) => `${thread.environmentId}:${thread.id}`);
  }, [pinReorderEnvironmentIds, threads]);
  const v2ScopedProjectGroup = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (v2ProjectGroups.find(
            (group) =>
              group.key === selectedProjectKey ||
              group.memberProjectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  selectedProjectKey,
              ),
          ) ?? null),
    [selectedProjectKey, v2ProjectGroups],
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
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
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
  const projectThreadList = useMemo(
    () =>
      buildProjectThreadListV2({
        threads: threads.filter((thread) => thread.archivedAt === null),
        groups: v2ProjectGroups,
        expansion: effectiveProjectExpansion,
        environmentId: options.selectedEnvironmentId,
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
      options.selectedEnvironmentId,
      props.searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threads,
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
  // Queued offline tasks are not thread shells, so the partition never sees
  // them; they render above PROJECTS (in flow, like the web drafts) and stay
  // visible and deletable while their environment is offline. Same
  // environment scope and search filter as the list.
  const listItems = useMemo<readonly SidebarListItem[]>(() => {
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
    const v2PendingTasks = pendingTasks.filter(
      (pendingTask) =>
        (options.selectedEnvironmentId === null ||
          pendingTask.message.environmentId === options.selectedEnvironmentId) &&
        (v2ScopedProjectGroup === null ||
          v2ScopedProjectGroup.memberProjectRefs.some(
            (projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
          )) &&
        (v2SearchQuery.length === 0 ||
          pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
    );
    return buildProjectThreadListV2ListItems({
      partition: projectThreadList,
      pendingTasks: v2PendingTasks,
      snoozedShelfExpanded,
      snoozeLabelNow: `${nowMinute}:00.000Z`,
    });
  }, [
    nowMinute,
    options.selectedEnvironmentId,
    pendingTasks,
    projectThreadList,
    props.searchQuery,
    snoozedShelfExpanded,
    v2ScopedProjectGroup,
  ]);
  // The settled dock lives below the scroll area and pages its own rows; the
  // split-view detail's thread stays pinned into the visible rows so it can
  // never lose its navigation row.
  const settledDockRows = useMemo(
    () =>
      resolveSettledDockRows({
        settled: projectThreadList.settled,
        expanded: settledShelfExpanded,
        visibleCount: settledVisibleCount,
        selectedThreadKey: props.selectedThreadKey ?? null,
      }),
    [projectThreadList.settled, props.selectedThreadKey, settledShelfExpanded, settledVisibleCount],
  );
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            subtitle: "Show threads from every environment",
            state: options.selectedEnvironmentId === null ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              options.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      ...(projectFilterOptions.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  subtitle: "Show threads from every project",
                  state: selectedProjectKey === null ? "on" : "off",
                },
                ...projectFilterOptions.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [environments, projectFilterOptions, selectedProjectKey, options.selectedEnvironmentId],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        setSelectedEnvironmentId(null);
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
        );
        if (environment) setSelectedEnvironmentId(environment.environmentId);
        return;
      }
      if (event === "project:all") {
        setSelectedProjectKey(null);
        return;
      }
      if (event.startsWith("project:")) {
        const projectKey = event.slice("project:".length);
        if (projectFilterOptions.some((project) => project.key === projectKey)) {
          setSelectedProjectKey(projectKey);
        }
        return;
      }
    },
    [environments, projectFilterOptions, setSelectedEnvironmentId],
  );

  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const headerFadeColor = String(backgroundColor);
  const headerWashOpacity = SIDEBAR_HEADER_WASH_OPACITY[colorScheme];
  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight = measuredHeaderHeight ?? insets.top + SIDEBAR_STICKY_HEADER_HEIGHT;
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
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
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > 6;
    if (headerIsOverContentRef.current === next) {
      return;
    }
    headerIsOverContentRef.current = next;
    setHeaderIsOverContent(next);
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Project shells load after the first rows draw, so the maps they feed have
  // to bust the recycler's memoization — otherwise a row keeps the blank
  // favicon and fallback title it was first rendered with.
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      projectByKey,
      projectCwdByKey,
      v2ProjectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      props.selectedThreadKey,
      projectByKey,
      projectCwdByKey,
      v2ProjectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
    ],
  );
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean => {
      if (previous.type === "v2-thread" && item.type === "v2-thread") {
        return (
          previous.key === item.key &&
          previous.item.thread === item.item.thread &&
          previous.item.variant === item.item.variant &&
          previous.item.snoozed === item.item.snoozed &&
          previous.item.pinned === item.item.pinned &&
          previous.snoozeWakeLabelText === item.snoozeWakeLabelText
        );
      }
      if (previous.type === "v2-project" && item.type === "v2-project") {
        return (
          previous.key === item.key &&
          previous.expanded === item.expanded &&
          previous.isFirstProject === item.isFirstProject &&
          previous.project.group === item.project.group &&
          previous.project.pinned === item.project.pinned &&
          previous.project.active === item.project.active
        );
      }
      if (previous.type === "v2-pending" && item.type === "v2-pending") {
        return (
          previous.pendingTask === item.pendingTask &&
          previous.showPendingDivider === item.showPendingDivider
        );
      }
      if (previous.type === "v2-snoozed-shelf" && item.type === "v2-snoozed-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      return false;
    },
    [],
  );
  const focusSearch = useCallback(() => {
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, [props.nativeChrome, props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  // Shared row wiring for list rows and the settled dock: a slim dock row is
  // just a v2 thread item with variant slim and no trailing hairline.
  const renderV2ThreadRow = useCallback(
    (item: ThreadListV2Item, snoozeWakeLabelText?: string) => {
      const thread = item.thread;
      const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
      return (
        <ThreadListV2Row
          thread={thread}
          variant={item.variant}
          snoozed={item.snoozed}
          pinned={item.pinned}
          snoozePresetMinute={nowMinute}
          snoozeWakeLabelText={snoozeWakeLabelText}
          project={projectByKey.get(scopeKey) ?? null}
          projectTitle={v2ProjectTitleByProjectKey.get(scopeKey)}
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
            Object.keys(savedConnectionsById).length > 1
              ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          pane="sidebar"
          selected={scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey}
          fullSwipeWidth={props.width - 20}
          onSelectThread={handleSelectThread}
          onDeleteThread={confirmDeleteThread}
          onArchiveThread={archiveThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={settleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          pinReorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
          canMovePinnedUp={arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`) > 0}
          canMovePinnedDown={(() => {
            const index = arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`);
            return index !== -1 && index < arrangedPinnedKeys.length - 1;
          })()}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onMovePinnedThread={movePinnedThread}
          onChangeRequestState={handleChangeRequestState}
          projectCwd={projectCwdByKey.get(scopeKey) ?? null}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          simultaneousSwipeGesture={sidebarScrollGesture}
        />
      );
    },
    [
      archiveThread,
      arrangedPinnedKeys,
      confirmDeleteThread,
      handleChangeRequestState,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      movePinnedThread,
      nowMinute,
      pinReorderEnvironmentIds,
      pinThread,
      pinningEnvironmentIds,
      projectByKey,
      projectCwdByKey,
      props.searchQuery,
      props.selectedThreadKey,
      props.width,
      regenerateThreadTitle,
      savedConnectionsById,
      serverConfigs,
      settlementEnvironmentIds,
      sidebarScrollGesture,
      snoozeEnvironmentIds,
      snoozeThread,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      settleThread,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      v2ProjectTitleByProjectKey,
    ],
  );
  // Settled rows render in the fixed dock below the scroll area; the dock
  // draws its own chrome and paging, so rows never carry a trailing hairline.
  const renderSettledRow = useCallback(
    (thread: EnvironmentThreadShell) =>
      renderV2ThreadRow({ thread, variant: "slim", snoozed: false, pinned: false, isLast: false }),
    [renderV2ThreadRow],
  );
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) => {
      switch (item.type) {
        case "v2-pending": {
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
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[item.pendingTask.message.environmentId]
                      ?.environmentLabel ?? null)
                  : null
              }
              pane="sidebar"
              showPendingDivider={item.showPendingDivider}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        }
        case "v2-project":
          return (
            <ThreadListV2ProjectRow
              project={item.project}
              expanded={item.expanded}
              isFirstProject={item.isFirstProject}
              onToggle={toggleProject}
              pane="sidebar"
            />
          );
        case "v2-thread":
          return renderV2ThreadRow(item.item, item.snoozeWakeLabelText);
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              expanded={item.expanded}
              onToggle={toggleSnoozedShelf}
              pane="sidebar"
            />
          );
      }
    },
    [
      confirmDeletePendingTask,
      openPendingTask,
      projectByKey,
      renderV2ThreadRow,
      savedConnectionsById,
      toggleProject,
      toggleSnoozedShelf,
    ],
  );
  const filterCustomized = options.selectedEnvironmentId !== null || selectedProjectKey !== null;
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        projects: projectFilterOptions,
        selectedEnvironmentId: options.selectedEnvironmentId,
        selectedProjectKey,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
      }),
    [environments, projectFilterOptions, options.selectedEnvironmentId, selectedProjectKey],
  );
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        filterIcon,
        filterMenu,
        onOpenSettings: props.onOpenSettings,
      }),
    [filterIcon, filterMenu, props.onOpenSettings],
  );
  // Snoozed threads need no special case: the shelf header is a list row
  // even while collapsed.
  const listEmpty = (
    <Text className="px-2 py-4 text-sm text-foreground-muted">
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : props.searchQuery.trim().length > 0
          ? threadSearch.isPending
            ? "Searching thread messages…"
            : "No matching threads"
          : v2ScopedProjectGroup !== null
            ? `No threads in ${v2ScopedProjectGroup.label}`
            : "No threads yet"}
    </Text>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={nativeHeaderItems}
          options={{
            // Re-applies the shell's static brand slot with the
            // connection-status swap so reconnects surface in the header
            // instead of shifting the list.
            ...getConnectionAwareBrandHeaderOptions({
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              // Keep the search bar pinned under the title — UIKit's default
              // hidesSearchBarWhenScrolling collapses it on scroll.
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  {
                    paddingBottom: 12,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
          <ThreadListV2SettledDock
            count={projectThreadList.settled.length}
            rows={settledDockRows.rows}
            hiddenCount={settledDockRows.hiddenCount}
            expanded={settledShelfExpanded}
            pane="sidebar"
            onToggle={toggleSettledShelf}
            onShowMore={showMoreSettled}
            renderRow={renderSettledRow}
            bottomPadding={Math.max(insets.bottom, 16) + 16}
          />
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1"
      style={{
        width: props.width,
        backgroundColor,
        borderRightColor: borderColor,
        borderRightWidth: StyleSheet.hairlineWidth,
      }}
    >
      <View className="flex-1">
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            <LegendList
              data={listItems}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={sidebarItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              contentContainerStyle={[
                styles.threadListContent,
                {
                  paddingBottom: 12,
                  paddingTop: topListInset,
                },
              ]}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              recycleItems
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.threadList}
              ListEmptyComponent={listEmpty}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
        <ThreadListV2SettledDock
          count={projectThreadList.settled.length}
          rows={settledDockRows.rows}
          hiddenCount={settledDockRows.hiddenCount}
          expanded={settledShelfExpanded}
          pane="sidebar"
          onToggle={toggleSettledShelf}
          onShowMore={showMoreSettled}
          renderRow={renderSettledRow}
          bottomPadding={Math.max(insets.bottom, 16) + 16}
        />
      </View>

      <View
        className="absolute inset-x-0 top-0 z-[4]"
        onLayout={handleStickyHeaderLayout}
        pointerEvents="box-none"
        style={{ paddingTop: insets.top }}
      >
        <View
          className="absolute inset-x-0 top-0"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ height: stickyHeaderHeight + SIDEBAR_STICKY_HEADER_FADE_HEIGHT }}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="sidebar-header-wash" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop
                  offset="0%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[0] : 0}
                />
                <Stop
                  offset="58%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[1] : 0}
                />
                <Stop
                  offset="88%"
                  stopColor={headerFadeColor}
                  stopOpacity={headerIsOverContent ? headerWashOpacity[2] : 0}
                />
                <Stop offset="100%" stopColor={headerFadeColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#sidebar-header-wash)" />
          </Svg>
        </View>
        <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
          {/* Title slot doubles as the connection status surface: while an
              environment reconnects, "Threads" fades to a status label in
              place (no layout shift in the list below). */}
          <WorkspaceConnectionTitle
            grow
            onPress={props.onOpenEnvironmentSettings}
            size="pageTitle"
            brand={
              <Text className="flex-1 text-[34px] font-t3-bold text-foreground" numberOfLines={1}>
                Threads
              </Text>
            }
          />
          <SidebarHeaderButtonGroup colorScheme={colorScheme}>
            <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
              <SidebarFilterButton
                grouped
                accessibilityLabel="Filter and sort threads"
                icon={filterIcon}
              />
            </ControlPillMenu>
            <SidebarHeaderActions grouped onOpenSettings={props.onOpenSettings} />
          </SidebarHeaderButtonGroup>
        </View>

        <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
          <SymbolView name="magnifyingglass" size={15} tintColor={mutedColor} type="monochrome" />
          <TextInput
            ref={searchInputRef}
            accessibilityLabel="Search threads"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={props.onSearchQueryChange}
            placeholder="Search"
            placeholderTextColor={placeholderColor}
            returnKeyType="search"
            className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
            value={props.searchQuery}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerButtonGroup: {
    alignItems: "center",
    borderRadius: 22,
    flexDirection: "row",
    overflow: "hidden",
  },
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
