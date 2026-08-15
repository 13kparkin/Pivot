import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SETTLED_DOCK_PAGE_COUNT } from "../Sidebar.logic";
import { TooltipProvider } from "../ui/tooltip";

export interface SidebarSettledDockProps {
  /** Settled rows to render (already capped + paged + open-thread pinned). */
  settled: readonly EnvironmentThreadShell[];
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
  onShowMore: () => void;
  renderThreadRow: (thread: EnvironmentThreadShell) => ReactNode;
}

/**
 * Fixed SETTLED dock, rendered as a sibling of the scroll content directly
 * above the chrome footer: expanding adds rows below the scroll area, so the
 * dock's top edge rises and the `flex-1` scroll viewport above shrinks —
 * "expands upward" with no layout invention. Collapsed is a header bar with
 * the count only; expanded rows cap at ~10 with internal scroll and page
 * +25 per "Show more".
 */
export function SidebarSettledDock(props: SidebarSettledDockProps) {
  return (
    <div className="flex w-full shrink-0 flex-col" data-testid="sidebar-settled-dock">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        data-testid="sidebar-settled-dock-toggle"
        className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
      >
        <span className="text-xs font-medium text-muted-foreground/50">
          {props.expanded ? "Settled" : `Settled (${props.settled.length})`}
        </span>
        <span aria-hidden className="h-px flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 text-muted-foreground/50 transition-transform",
            props.expanded && "rotate-180",
          )}
        />
      </button>
      {props.expanded ? (
        <div className="max-h-96 min-h-0 overflow-y-auto" data-testid="sidebar-settled-dock-rows">
          <TooltipProvider
            key="sidebar-settled-tooltips-150"
            delay={150}
            closeDelay={0}
            timeout={400}
          >
            <ul role="list" className="flex flex-col gap-px">
              {props.settled.map((thread) => props.renderThreadRow(thread))}
            </ul>
          </TooltipProvider>
          {props.hiddenCount > 0 ? (
            <button
              type="button"
              onClick={props.onShowMore}
              data-testid="sidebar-settled-dock-show-more"
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon aria-hidden className="size-4 shrink-0" />
              Show {Math.min(props.hiddenCount, SETTLED_DOCK_PAGE_COUNT)} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
