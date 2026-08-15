import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  FolderIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useCanGoBack, useNavigate, useSearch } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import {
  CAPABILITIES_SECTION_LABELS,
  searchCapabilities,
  type CapabilitiesPath,
  type CapabilitiesSearchItem,
} from "./capabilitiesNav";

const CAPABILITIES_SECTION_ICONS: Readonly<
  Record<CapabilitiesPath, ComponentType<{ className?: string }>>
> = {
  "/capabilities": LayoutDashboardIcon,
  "/capabilities/settings": Settings2Icon,
  "/capabilities/skills": BookOpenIcon,
  "/capabilities/rules": ScrollTextIcon,
};

export const CAPABILITIES_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: CapabilitiesPath;
  icon: ComponentType<{ className?: string }>;
}> = (Object.keys(CAPABILITIES_SECTION_LABELS) as CapabilitiesPath[]).map((to) => ({
  to,
  label: CAPABILITIES_SECTION_LABELS[to],
  icon: CAPABILITIES_SECTION_ICONS[to],
}));

function CapabilitiesSectionIcon({ to }: { to: CapabilitiesPath }) {
  const Icon = CAPABILITIES_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />;
}

export function CapabilitiesSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const { projectKey } = useSearch({ from: "/capabilities" });
  const groups = useSettingsProjectGroups();
  const projectGroup =
    projectKey === undefined
      ? null
      : (groups.find((group) => group.projectKey === projectKey) ?? null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = useMemo(() => searchCapabilities(query), [query]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`capabilities-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Keep focus inside open dialogs and popups instead of escaping
          // their focus trap into the sidebar search.
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  const handleSectionClick = useCallback(
    (to: CapabilitiesPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      // A project-scoped view must stay scoped: section navigations carry
      // the projectKey search param so the sidebar never silently falls
      // back to the global surface.
      void navigate({
        to,
        hash: "",
        replace: true,
        ...(projectKey !== undefined ? { search: { projectKey } } : {}),
      });
    },
    [isMobile, navigate, projectKey, setOpenMobile],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (item: CapabilitiesSearchItem) => {
      clearSearch();
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: item.to,
        replace: true,
        ...(projectKey !== undefined ? { search: { projectKey } } : {}),
      });
    },
    [clearSearch, isMobile, navigate, projectKey, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results],
  );

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <Input
              ref={searchInputRef}
              nativeInput
              unstyled
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveResultIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search"
              aria-label="Search capabilities"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isSearching && hasResults}
              aria-controls={isSearching && hasResults ? "capabilities-search-results" : undefined}
              aria-activedescendant={
                isSearching && results[activeResultIndex]
                  ? `capabilities-search-result-${results[activeResultIndex].id}`
                  : undefined
              }
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
            />
            {isSearching ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0 rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                aria-label="Clear capabilities search"
                onClick={() => {
                  clearSearch();
                  searchInputRef.current?.focus();
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">/</Kbd>
            )}
          </div>
          {isSearching && results.length === 0 ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
            >
              No capabilities found
            </p>
          ) : null}
          <SidebarMenu
            className="ps-px"
            id={isSearching && hasResults ? "capabilities-search-results" : undefined}
            role={isSearching && hasResults ? "listbox" : undefined}
            aria-label={isSearching && hasResults ? "Capabilities search results" : undefined}
          >
            {isSearching
              ? results.map((item, index) => (
                  <SidebarMenuItem key={item.id} role="presentation">
                    <SidebarMenuButton
                      id={`capabilities-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <CapabilitiesSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-[11px] text-sidebar-muted-foreground/75">
                          {CAPABILITIES_SECTION_LABELS[item.to]}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              : CAPABILITIES_NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => handleSectionClick(item.to)}
                      >
                        <Icon />
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        {projectGroup !== null ? (
          <div
            data-testid="capabilities-project-context"
            className="mb-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-sidebar-muted-foreground"
          >
            <FolderIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{projectGroup.displayName}</span>
          </div>
        ) : null}
        <SidebarMenu className="min-w-0 flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
