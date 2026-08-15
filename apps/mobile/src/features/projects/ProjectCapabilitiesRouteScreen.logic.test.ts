import type { ProjectGroup } from "@t3tools/client-runtime/state/project-grouping";
import type { OmpCapabilityItem, OmpSettingsSurfaceEntry } from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCapabilitiesSnapshotInput,
  buildCapabilityItemRows,
  buildDeleteResourceInput,
  buildReadResourceInput,
  buildResetSettingInput,
  buildSettingRows,
  buildWriteResourceInput,
  buildWriteSettingInput,
  canEditEntry,
  isValidItemName,
  resolveProjectCapabilitiesTarget,
  withTemplateName,
} from "./ProjectCapabilitiesRouteScreen.logic";

const environmentId = EnvironmentId.make("environment-1");
const remoteEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");

function makeGroup(
  refs: ReadonlyArray<{ environmentId: EnvironmentId; projectId: ProjectId }>,
): ProjectGroup {
  return {
    key: "group-a",
    label: "Group A",
    representative: {
      environmentId: refs[0]?.environmentId ?? environmentId,
      id: refs[0]?.projectId ?? projectId,
      title: "Group A",
      workspaceRoot: "/work/a",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    members: refs.map((ref) => ({
      physicalProjectKey: `${ref.environmentId}:${ref.projectId}`,
      project: {
        environmentId: ref.environmentId,
        id: ref.projectId,
        title: "Group A",
        workspaceRoot: "/work/a",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    })),
    memberProjectRefs: refs,
  };
}

describe("buildCapabilitiesSnapshotInput", () => {
  it("carries the projectId for a project-scoped snapshot", () => {
    expect(buildCapabilitiesSnapshotInput(projectId)).toEqual({ projectId });
  });

  it("omits projectId when no project is resolved (global snapshot)", () => {
    expect(buildCapabilitiesSnapshotInput(null)).toEqual({});
  });
});

describe("buildWriteSettingInput", () => {
  it("carries projectId on a project-scoped write", () => {
    expect(
      buildWriteSettingInput({
        key: "threads.autoSettle",
        value: "7",
        scope: "project",
        projectId,
      }),
    ).toEqual({ key: "threads.autoSettle", value: "7", scope: "project", projectId });
  });

  it("omits projectId when none is resolved", () => {
    expect(
      buildWriteSettingInput({ key: "k", value: "v", scope: "project", projectId: null }),
    ).toEqual({ key: "k", value: "v", scope: "project" });
  });
});

describe("buildResetSettingInput", () => {
  it("requires confirm and carries projectId for the project scope", () => {
    expect(buildResetSettingInput({ key: "k", scope: "project", projectId })).toEqual({
      key: "k",
      scope: "project",
      projectId,
      confirm: true,
    });
  });

  it("omits projectId when none is resolved", () => {
    expect(buildResetSettingInput({ key: "k", scope: "project", projectId: null })).toEqual({
      key: "k",
      scope: "project",
      confirm: true,
    });
  });
});

describe("resource inputs", () => {
  it("carries projectId on project-scoped reads, writes, and deletes", () => {
    expect(
      buildReadResourceInput({ kind: "rules", name: "code", scope: "project", projectId }),
    ).toEqual({ kind: "rules", name: "code", scope: "project", projectId });
    expect(
      buildWriteResourceInput({
        kind: "rules",
        name: "code",
        content: "content",
        scope: "project",
        projectId,
        overwrite: true,
      }),
    ).toEqual({
      kind: "rules",
      name: "code",
      content: "content",
      scope: "project",
      projectId,
      overwrite: true,
    });
    expect(
      buildDeleteResourceInput({ kind: "skills", name: "fix", scope: "project", projectId }),
    ).toEqual({ kind: "skills", name: "fix", scope: "project", projectId, confirm: true });
  });

  it("omits projectId when none is resolved (global item)", () => {
    expect(
      buildReadResourceInput({ kind: "rules", name: "code", scope: "global", projectId: null }),
    ).toEqual({ kind: "rules", name: "code", scope: "global" });
    expect(
      buildWriteResourceInput({
        kind: "rules",
        name: "code",
        content: "content",
        scope: "global",
        projectId: null,
        overwrite: false,
      }),
    ).toEqual({
      kind: "rules",
      name: "code",
      content: "content",
      scope: "global",
      overwrite: false,
    });
    expect(
      buildDeleteResourceInput({ kind: "skills", name: "fix", scope: "global", projectId: null }),
    ).toEqual({ kind: "skills", name: "fix", scope: "global", confirm: true });
  });
});

describe("buildSettingRows", () => {
  it("masks secret values and keeps plain display values", () => {
    const rows = buildSettingRows([
      {
        key: "token",
        value: "abc",
        type: "string",
        description: "Secret",
        masked: true,
        scope: "project",
      },
      {
        key: "settleDays",
        value: 7,
        type: "number",
        description: "Days",
        masked: false,
        scope: "global",
      },
    ] as OmpSettingsSurfaceEntry[]);

    expect(rows.map((row) => row.displayValue)).toEqual(["********", "7"]);
    expect(canEditEntry(rows[0]!)).toBe(false);
    expect(canEditEntry(rows[1]!)).toBe(true);
  });
});

describe("buildCapabilityItemRows", () => {
  it("lists global first, then project, with scope labels and shadow flags", () => {
    const rows = buildCapabilityItemRows([
      { name: "fix", scope: "project", description: "Project fix" },
      { name: "code", scope: "global", description: "Global code" },
      { name: "fix", scope: "global", description: "Global fix" },
    ] as OmpCapabilityItem[]);

    expect(rows.map((row) => row.name)).toEqual(["code", "fix", "fix"]);
    expect(rows.map((row) => row.scopeLabel)).toEqual(["Global", "Global", "Project"]);
    expect(rows[2]?.shadowed).toBe(true);
  });
});

describe("item name + template helpers", () => {
  it("validates slugs and fills the skill template name", () => {
    expect(isValidItemName("fix-login")).toBe(true);
    expect(isValidItemName("has space")).toBe(false);
    expect(isValidItemName("")).toBe(false);
    expect(withTemplateName("name: {{name}}", "fix-login")).toBe("name: fix-login");
  });
});

describe("resolveProjectCapabilitiesTarget", () => {
  it("prefers the member in the active environment", () => {
    const group = makeGroup([
      { environmentId, projectId: ProjectId.make("project-1") },
      { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-2") },
    ]);

    expect(resolveProjectCapabilitiesTarget(group, environmentId)).toEqual({
      environmentId,
      projectId: ProjectId.make("project-1"),
    });
  });

  it("falls back to the first member when the active environment is absent", () => {
    const group = makeGroup([
      { environmentId, projectId: ProjectId.make("project-1") },
      { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-2") },
    ]);

    expect(resolveProjectCapabilitiesTarget(group, EnvironmentId.make("other"))).toEqual({
      environmentId,
      projectId: ProjectId.make("project-1"),
    });
  });

  it("returns null for a group with no members", () => {
    expect(resolveProjectCapabilitiesTarget(makeGroup([]), environmentId)).toBeNull();
  });
});
