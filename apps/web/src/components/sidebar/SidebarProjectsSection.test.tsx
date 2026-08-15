import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarProjectsSection, type SidebarProjectsSectionProps } from "./SidebarProjectsSection";

const localEnv = EnvironmentId.make("environment-local");
const NOW = "2026-04-10T00:00:00.000Z";

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnv,
    projectId: ProjectId.make("project-a"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<SidebarProjectSnapshot> = {}): SidebarProjectSnapshot {
  return {
    id: ProjectId.make("project-a"),
    environmentId: localEnv,
    title: "Project A",
    workspaceRoot: "/tmp/project-a",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    projectKey: "project-a",
    displayName: "Project A",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: [],
    memberProjectRefs: [{ environmentId: localEnv, projectId: ProjectId.make("project-a") }],
    remoteEnvironmentLabels: [],
    ...overrides,
  };
}

function renderSection(props: Partial<SidebarProjectsSectionProps> = {}) {
  return renderToStaticMarkup(
    <SidebarProjectsSection
      projects={[]}
      expansionByKey={{}}
      sortablePinnedKeys={new Set()}
      onToggleProject={() => {}}
      onOpenCapabilities={() => {}}
      renderThreadRow={(thread, section) => (
        <li data-testid={`row-${section}-${thread.id}`}>{thread.title}</li>
      )}
      {...props}
    />,
  );
}

describe("SidebarProjectsSection", () => {
  const groupA = makeGroup();
  const groupB = makeGroup({
    id: ProjectId.make("project-b"),
    title: "Project B",
    projectKey: "project-b",
    displayName: "Project B",
    memberProjectRefs: [{ environmentId: localEnv, projectId: ProjectId.make("project-b") }],
  });
  const pinned = makeShell({
    id: ThreadId.make("t-pinned"),
    pinnedAt: NOW,
    pinOrderKey: "aaaa",
  });
  const active = makeShell({ id: ThreadId.make("t-active") });

  it("renders a row per project with display name, env badge, and capabilities gear", () => {
    const markup = renderSection({
      projects: [
        {
          group: { ...groupA, remoteEnvironmentLabels: ["Tailscale"] },
          pinned: [],
          active: [],
        },
      ],
    });

    expect(markup).toContain('data-testid="sidebar-projects-section"');
    expect(markup).toContain('data-testid="sidebar-project-row-project-a"');
    expect(markup).toContain("Project A");
    expect(markup).toContain('data-testid="sidebar-project-env-badge-project-a"');
    expect(markup).toContain("Tailscale");
    expect(markup).toContain('aria-label="Open capabilities for Project A"');
  });

  it("defaults projects with threads to expanded and nests pinned before active cards", () => {
    const markup = renderSection({
      projects: [{ group: groupA, pinned: [pinned], active: [active] }],
    });

    expect(markup).toContain('data-testid="sidebar-project-threads-project-a"');
    expect(markup).toContain('data-testid="row-pinned-t-pinned"');
    expect(markup).toContain('data-testid="row-active-t-active"');
    expect(markup.indexOf("row-pinned-t-pinned")).toBeLessThan(
      markup.indexOf("row-active-t-active"),
    );
    expect(markup).toContain('aria-expanded="true"');
  });

  it("defaults empty projects to collapsed without nested cards", () => {
    const markup = renderSection({
      projects: [{ group: groupB, pinned: [], active: [] }],
    });

    expect(markup).not.toContain('data-testid="sidebar-project-threads-project-b"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("renders empty projects expanded when a persisted override says so", () => {
    const markup = renderSection({
      projects: [{ group: groupB, pinned: [], active: [] }],
      expansionByKey: { "project-b": true },
    });

    expect(markup).toContain('data-testid="sidebar-project-threads-project-b"');
    expect(markup).toContain('aria-expanded="true"');
  });

  it("collapses a project with threads when a persisted override says so", () => {
    const markup = renderSection({
      projects: [{ group: groupA, pinned: [pinned], active: [active] }],
      expansionByKey: { "project-a": false },
    });

    expect(markup).not.toContain('data-testid="sidebar-project-threads-project-a"');
    expect(markup).not.toContain("row-pinned-t-pinned");
  });

  it("renders no env badge when the group has no remote environment labels", () => {
    const markup = renderSection({
      projects: [{ group: groupA, pinned: [], active: [] }],
    });

    expect(markup).not.toContain("sidebar-project-env-badge-project-a");
  });
});
