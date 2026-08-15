import { useSortable } from "@dnd-kit/sortable";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronDownIcon, ServerIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveProjectExpansionState } from "../Sidebar.logic";

// Subset of useSortable applied to a pinned card's root <li>. Listeners go
// on the whole card (no dedicated handle): the pointer sensor's distance
// constraint keeps plain clicks working, and we skip dnd-kit's aria
// attributes since there is no keyboard sensor and the card body already
// carries its own button semantics.
export type SortablePinnedRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export function SortablePinnedThreadRow(props: {
  id: string;
  children: (bag: SortablePinnedRowBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return props.children({ listeners, setNodeRef, transform, transition, isDragging });
}

export interface SidebarProjectsSectionProps {
  /** Per-project pinned/active buckets in sidebar group order (pivot-22 partition). */
  projects: ReadonlyArray<{
    group: SidebarProjectSnapshot;
    pinned: EnvironmentThreadShell[];
    active: EnvironmentThreadShell[];
  }>;
  /** Persisted expansion overrides, keyed by logical projectKey. */
  expansionByKey: Readonly<Record<string, boolean>>;
  /** Pinned thread keys the server allows dragging; rows outside the set render in place. */
  sortablePinnedKeys: ReadonlySet<string>;
  onToggleProject: (projectKey: string, expanded: boolean) => void;
  onOpenCapabilities: (group: SidebarProjectSnapshot) => void;
  renderThreadRow: (
    thread: EnvironmentThreadShell,
    section: "pinned" | "active",
    sortable?: SortablePinnedRowBag,
  ) => ReactNode;
}

/**
 * PROJECTS section: one expandable row per logical project group with its
 * pinned + active thread cards nested underneath (pinned first). The gear
 * opens the project's capabilities. Expansion defaults to open for projects
 * with threads and collapses empty ones; persisted overrides win.
 */
export function SidebarProjectsSection(props: SidebarProjectsSectionProps) {
  const { projects } = props;
  return (
    <li className="list-none" data-testid="sidebar-projects-section">
      <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
        <span className="text-xs font-medium text-sidebar-muted-foreground">Projects</span>
        <span aria-hidden className="h-px flex-1 bg-sidebar-border/60" />
      </div>
      <ul role="list" className="flex flex-col gap-px">
        {projects.map(({ group, pinned, active }) => {
          const hasThreads = pinned.length + active.length > 0;
          const expanded =
            props.expansionByKey[group.projectKey] ??
            resolveProjectExpansionState(group.projectKey, hasThreads);
          const threadKey = (thread: EnvironmentThreadShell) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <li
              key={group.projectKey}
              className="list-none"
              data-testid={`sidebar-project-row-${group.projectKey}`}
            >
              <div className="flex min-w-0 items-center gap-0.5 pe-1 ps-2">
                <button
                  type="button"
                  onClick={() => props.onToggleProject(group.projectKey, !expanded)}
                  aria-expanded={expanded}
                  aria-label={`${group.displayName} project`}
                  className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-sm font-medium text-sidebar-foreground hover:bg-sidebar-row-hover"
                >
                  <ChevronDownIcon
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-sidebar-muted-foreground/70 transition-transform",
                      expanded && "rotate-180",
                    )}
                  />
                  <ProjectFavicon
                    environmentId={group.environmentId}
                    cwd={group.workspaceRoot}
                    faviconPath={group.faviconPath}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                  {group.remoteEnvironmentLabels.length > 0 ? (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-row-hover px-1.5 py-0.5 text-[11px] font-normal text-sidebar-muted-foreground"
                      data-testid={`sidebar-project-env-badge-${group.projectKey}`}
                    >
                      <ServerIcon aria-hidden className="size-3" />
                      {group.remoteEnvironmentLabels.join(", ")}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Open capabilities for ${group.displayName}`}
                  title={`Capabilities for ${group.displayName}`}
                  onClick={() => props.onOpenCapabilities(group)}
                  className="ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <SettingsIcon className="size-3.5" />
                </button>
              </div>
              {expanded ? (
                <ul
                  className="flex flex-col gap-px"
                  data-testid={`sidebar-project-threads-${group.projectKey}`}
                >
                  {pinned.map((thread) => {
                    const key = threadKey(thread);
                    if (props.sortablePinnedKeys.has(key)) {
                      return (
                        <SortablePinnedThreadRow key={key} id={key}>
                          {(bag) => props.renderThreadRow(thread, "pinned", bag)}
                        </SortablePinnedThreadRow>
                      );
                    }
                    return props.renderThreadRow(thread, "pinned");
                  })}
                  {active.map((thread) => props.renderThreadRow(thread, "active"))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
