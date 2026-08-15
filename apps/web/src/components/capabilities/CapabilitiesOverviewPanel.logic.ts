import type {
  EnvironmentId,
  OmpCapabilitiesSnapshot,
  OmpCapabilityResource,
  ProjectId,
} from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

/**
 * Resolve the project omp should operate on for the active environment.
 * An explicit `projectKey` (from the ?projectKey= capabilities search param)
 * picks that group's member in the active environment; without one the first
 * group member whose project lives in that environment wins, so the global
 * entry (/capabilities without ?projectKey=) behaves exactly as before.
 */
export function resolveCapabilitiesProjectId(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  environmentId: EnvironmentId | null,
  projectKey?: string | null,
): ProjectId | null {
  if (environmentId === null) return null;
  if (projectKey) {
    const group = groups.find((candidate) => candidate.projectKey === projectKey) ?? null;
    return (
      group?.memberProjects.find((member) => member.environmentId === environmentId)?.id ?? null
    );
  }
  for (const group of groups) {
    for (const member of group.memberProjects) {
      if (member.environmentId === environmentId) return member.id;
    }
  }
  return null;
}

/**
 * Project id for a capabilities VIEW: only an explicit `projectKey` (the
 * sidebar gear) resolves a project. The global entry (/capabilities without
 * ?projectKey=) is truly global — it must not fall back to the first project,
 * which would leak that project's items and layer into the global surface.
 */
export function resolveCapabilitiesProjectIdForView(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  environmentId: EnvironmentId | null,
  projectKey?: string | null,
): ProjectId | null {
  return projectKey === null || projectKey === undefined
    ? null
    : resolveCapabilitiesProjectId(groups, environmentId, projectKey);
}

/** Display order: broadest scope first. */
const SCOPE_ORDER: Readonly<Record<OmpCapabilityResource["scope"], number>> = {
  global: 0,
  project: 1,
  profile: 2,
};

export interface CapabilityRow {
  readonly resource: OmpCapabilityResource;
  readonly label: string;
  readonly scopeLabel: string;
  readonly provenanceLabel: string;
  readonly statusLabel: string;
}

function statusLabelFor(resource: OmpCapabilityResource): string {
  if (!resource.exists) return "missing";
  return resource.hasValue === true || resource.masked !== true ? "present" : "masked";
}

/**
 * Present the discovered capability resources in display order (scope, then
 * kind) with human-readable labels for the scope/provenance/status columns.
 */
export function buildCapabilityRows(
  resources: ReadonlyArray<OmpCapabilityResource>,
): ReadonlyArray<CapabilityRow> {
  return resources
    .map((resource) => ({
      resource,
      label: resource.name,
      scopeLabel:
        resource.scope === "global"
          ? "Global"
          : resource.scope === "project"
            ? "Project"
            : "Profile",
      provenanceLabel: resource.provenance,
      statusLabel: statusLabelFor(resource),
    }))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.resource.scope] - SCOPE_ORDER[b.resource.scope] ||
        a.resource.kind.localeCompare(b.resource.kind),
    );
}

/** Sections the project-scoped overview launches into. */
export type CapabilitiesOverviewCardTarget =
  | "/capabilities/settings"
  | "/capabilities/skills"
  | "/capabilities/rules";

export interface CapabilitiesOverviewCard {
  readonly to: CapabilitiesOverviewCardTarget;
  readonly label: string;
  readonly description: string;
  readonly count: number;
}

/**
 * Launcher cards for the project-scoped overview. Counts are project-only:
 * settings entries arrive pre-scoped from the server (the project's own
 * config layer), while skills/rules still carry global items — only
 * `scope === "project"` items count toward those cards.
 */
export function buildProjectCapabilitiesOverviewCards(
  snapshot: OmpCapabilitiesSnapshot,
): ReadonlyArray<CapabilitiesOverviewCard> {
  return [
    {
      to: "/capabilities/settings",
      label: "Settings",
      description: "Edit the omp settings this project overrides.",
      count: snapshot.settings.entries.length,
    },
    {
      to: "/capabilities/skills",
      label: "Skills",
      description: "Manage the skills this project can use.",
      count: snapshot.skills.filter((item) => item.scope === "project").length,
    },
    {
      to: "/capabilities/rules",
      label: "Rules",
      description: "Manage the rules loaded for this project.",
      count: snapshot.rules.filter((item) => item.scope === "project").length,
    },
  ];
}
