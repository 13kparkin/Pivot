import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarSettledDock, type SidebarSettledDockProps } from "./SidebarSettledDock";

function renderDock(props: Partial<SidebarSettledDockProps> = {}) {
  return renderToStaticMarkup(
    <SidebarSettledDock
      settled={[]}
      expanded={false}
      hiddenCount={0}
      onToggle={() => {}}
      onShowMore={() => {}}
      renderThreadRow={(thread) => <li data-testid={`settled-row-${thread.id}`}>{thread.title}</li>}
      {...props}
    />,
  );
}

describe("SidebarSettledDock", () => {
  it("collapses to a header bar with the count and no rows", () => {
    const markup = renderDock({
      settled: [
        { id: "t-1", title: "Thread 1" },
        { id: "t-2", title: "Thread 2" },
        { id: "t-3", title: "Thread 3" },
      ] as unknown as EnvironmentThreadShell[],
    });

    expect(markup).toContain('data-testid="sidebar-settled-dock"');
    expect(markup).toContain('data-testid="sidebar-settled-dock-toggle"');
    expect(markup).toContain("Settled (3)");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("sidebar-settled-dock-rows");
    expect(markup).not.toContain("sidebar-settled-dock-show-more");
  });

  it("renders rows and a show-more action when expanded with hidden rows", () => {
    const settled = [{ id: "t-1", title: "Thread 1" }] as unknown as EnvironmentThreadShell[];
    const markup = renderDock({ settled, expanded: true, hiddenCount: 25 });

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-testid="sidebar-settled-dock-rows"');
    expect(markup).toContain('data-testid="settled-row-t-1"');
    expect(markup).toContain('data-testid="sidebar-settled-dock-show-more"');
    expect(markup).toContain("Show 25 more");
  });

  it("omits the show-more action when every settled row is visible", () => {
    const settled = [{ id: "t-1", title: "Thread 1" }] as unknown as EnvironmentThreadShell[];
    const markup = renderDock({ settled, expanded: true, hiddenCount: 0 });

    expect(markup).not.toContain("sidebar-settled-dock-show-more");
    expect(markup).toContain('data-testid="settled-row-t-1"');
  });
});
