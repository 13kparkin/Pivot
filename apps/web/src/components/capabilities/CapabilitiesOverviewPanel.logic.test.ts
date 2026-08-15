import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type OmpCapabilitiesSnapshot,
  type OmpCapabilityItem,
  type OmpCapabilityResource,
  ProjectId,
  type ProjectId as ProjectIdType,
} from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";

import {
  buildCapabilityRows,
  buildProjectCapabilitiesOverviewCards,
  resolveCapabilitiesProjectId,
  resolveCapabilitiesProjectIdForView,
} from "./CapabilitiesOverviewPanel.logic";

const ENV_LOCAL = EnvironmentId.make("environment-local");
const ENV_REMOTE = EnvironmentId.make("environment-remote");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const PROJECT_C = ProjectId.make("project-c");

function makeMember(environmentId: EnvironmentId, id: ProjectIdType): SidebarProjectGroupMember {
  return {
    id,
    environmentId,
    title: id,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    physicalProjectKey: id,
    environmentLabel: null,
  } as SidebarProjectGroupMember;
}

function makeGroup(
  projectKey: string,
  members: ReadonlyArray<SidebarProjectGroupMember>,
): SidebarProjectSnapshot {
  return { projectKey, memberProjects: members } as SidebarProjectSnapshot;
}

describe("resolveCapabilitiesProjectId", () => {
  it("picks the member of the active environment from its group", () => {
    const groups = [
      makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A), makeMember(ENV_REMOTE, PROJECT_B)]),
      makeGroup("group-b", [makeMember(ENV_LOCAL, PROJECT_C)]),
    ];
    expect(resolveCapabilitiesProjectId(groups, ENV_REMOTE)).toBe(PROJECT_B);
    expect(resolveCapabilitiesProjectId(groups, ENV_LOCAL)).toBe(PROJECT_A);
  });

  it("returns null without an environment", () => {
    const groups = [makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A)])];
    expect(resolveCapabilitiesProjectId(groups, null)).toBeNull();
  });

  it("returns null when no group has a member in the active environment", () => {
    const groups = [makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A)])];
    expect(resolveCapabilitiesProjectId(groups, ENV_REMOTE)).toBeNull();
  });

  it("returns null for no groups", () => {
    expect(resolveCapabilitiesProjectId([], ENV_LOCAL)).toBeNull();
  });

  it("prefers an explicit projectKey over the first-project fallback", () => {
    const groups = [
      makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A)]),
      makeGroup("group-b", [makeMember(ENV_LOCAL, PROJECT_B)]),
    ];
    expect(resolveCapabilitiesProjectId(groups, ENV_LOCAL, "group-b")).toBe(PROJECT_B);
    expect(resolveCapabilitiesProjectId(groups, ENV_LOCAL, "group-a")).toBe(PROJECT_A);
  });

  it("returns null for an unknown projectKey", () => {
    const groups = [makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A)])];
    expect(resolveCapabilitiesProjectId(groups, ENV_LOCAL, "missing-group")).toBeNull();
  });

  it("resolves the explicit projectKey against the active environment's member", () => {
    const groups = [
      makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A), makeMember(ENV_REMOTE, PROJECT_B)]),
    ];
    expect(resolveCapabilitiesProjectId(groups, ENV_REMOTE, "group-a")).toBe(PROJECT_B);
  });
});

describe("resolveCapabilitiesProjectIdForView", () => {
  const groups = [
    makeGroup("group-a", [makeMember(ENV_LOCAL, PROJECT_A)]),
    makeGroup("group-b", [makeMember(ENV_LOCAL, PROJECT_B)]),
  ];

  it("returns null for the global entry even when projects exist", () => {
    expect(resolveCapabilitiesProjectIdForView(groups, ENV_LOCAL, null)).toBeNull();
    expect(resolveCapabilitiesProjectIdForView(groups, ENV_LOCAL, undefined)).toBeNull();
  });

  it("resolves the explicit projectKey to its member in the active environment", () => {
    expect(resolveCapabilitiesProjectIdForView(groups, ENV_LOCAL, "group-b")).toBe(PROJECT_B);
  });

  it("returns null for an unknown projectKey", () => {
    expect(resolveCapabilitiesProjectIdForView(groups, ENV_LOCAL, "missing")).toBeNull();
  });

  it("returns null without an environment", () => {
    expect(resolveCapabilitiesProjectIdForView(groups, null, "group-a")).toBeNull();
  });
});

const BASE_RESOURCE: OmpCapabilityResource = {
  kind: "config",
  name: "config.yml",
  scope: "global",
  provenance: "global",
  exists: true,
};

function resource(overrides: Partial<OmpCapabilityResource>): OmpCapabilityResource {
  return { ...BASE_RESOURCE, ...overrides };
}

describe("buildCapabilityRows", () => {
  it("labels name, scope, provenance and status", () => {
    const rows = buildCapabilityRows([
      resource({ name: "config.yml", scope: "global", provenance: "project", exists: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      label: "config.yml",
      scopeLabel: "Global",
      provenanceLabel: "project",
      statusLabel: "present",
    });
    expect(rows[0]!.resource).toEqual(
      resource({ name: "config.yml", scope: "global", provenance: "project", exists: true }),
    );
  });

  it("maps status: missing when the resource does not exist", () => {
    const rows = buildCapabilityRows([resource({ name: "skills", exists: false })]);
    expect(rows[0]!.statusLabel).toBe("missing");
  });

  it("maps status: present when hasValue is set", () => {
    const rows = buildCapabilityRows([
      resource({ name: "env", kind: "env", exists: true, hasValue: true }),
    ]);
    expect(rows[0]!.statusLabel).toBe("present");
  });

  it("maps status: masked when the resource content is masked", () => {
    const rows = buildCapabilityRows([
      resource({ name: "env", kind: "env", exists: true, masked: true }),
    ]);
    expect(rows[0]!.statusLabel).toBe("masked");
  });

  it("maps status: present for a plain existing resource", () => {
    const rows = buildCapabilityRows([resource({ name: "config.yml", exists: true })]);
    expect(rows[0]!.statusLabel).toBe("present");
  });

  it("sorts by scope then kind", () => {
    const rows = buildCapabilityRows([
      resource({ name: "project-config", kind: "config", scope: "project" }),
      resource({ name: "global-skills", kind: "skills", scope: "global" }),
      resource({ name: "global-config", kind: "config", scope: "global" }),
      resource({ name: "profile-hooks", kind: "hooks", scope: "profile" }),
    ]);
    expect(rows.map((row) => row.resource.name)).toEqual([
      "global-config",
      "global-skills",
      "project-config",
      "profile-hooks",
    ]);
  });
});

function item(name: string, scope: OmpCapabilityItem["scope"]): OmpCapabilityItem {
  return { name, scope };
}

function snapshot(overrides: {
  readonly settings?: number;
  readonly skills?: ReadonlyArray<OmpCapabilityItem>;
  readonly rules?: ReadonlyArray<OmpCapabilityItem>;
}): OmpCapabilitiesSnapshot {
  return {
    agentDirLabel: "~/.omp/agent",
    settings: {
      entries: Array.from({ length: overrides.settings ?? 0 }, (_, index) => ({
        key: `key-${index}`,
        value: "value",
        type: "string",
        description: "",
        masked: false,
        scope: "project",
      })),
    },
    resources: [],
    skills: overrides.skills ?? [],
    rules: overrides.rules ?? [],
  };
}

describe("buildProjectCapabilitiesOverviewCards", () => {
  it("counts only project-scoped skills and rules; settings count is the entries array as-is", () => {
    const cards = buildProjectCapabilitiesOverviewCards(
      snapshot({
        settings: 2,
        skills: [item("project-skill", "project"), item("global-skill", "global")],
        rules: [item("project-rule", "project"), item("global-rule", "global")],
      }),
    );
    expect(cards).toEqual([
      {
        to: "/capabilities/settings",
        label: "Settings",
        description: expect.any(String),
        count: 2,
      },
      { to: "/capabilities/skills", label: "Skills", description: expect.any(String), count: 1 },
      { to: "/capabilities/rules", label: "Rules", description: expect.any(String), count: 1 },
    ]);
  });

  it("counts zero for every card when the snapshot holds only global items", () => {
    const cards = buildProjectCapabilitiesOverviewCards(
      snapshot({
        skills: [item("global-skill", "global")],
        rules: [item("global-rule", "global")],
      }),
    );
    expect(cards.map((card) => card.count)).toEqual([0, 0, 0]);
  });

  it("keeps the launcher targets in settings/skills/rules order", () => {
    const cards = buildProjectCapabilitiesOverviewCards(snapshot({}));
    expect(cards.map((card) => card.to)).toEqual([
      "/capabilities/settings",
      "/capabilities/skills",
      "/capabilities/rules",
    ]);
  });
});
